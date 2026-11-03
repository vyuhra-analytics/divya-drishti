// Least-privilege database role for the running services. The services connect with DATABASE_URL, which today is the Postgres superuser (it was made one so that
// `CREATE EXTENSION timescaledb` works), so a bug in any query would run with every right. This creates `drishti_app`: it can read and change rows and use
// sequences, and nothing else (no DDL, no superuser, no new roles). Migrations keep using the owner through MIGRATE_DATABASE_URL.
//   bun run db:harden                 dry run: prints what it would do
//   bun run db:harden -- --apply      creates the role (or re-grants if it exists) and writes its connection URL to .drishti-app-db-url (git-ignored; the password is never printed)
//   bun run db:harden -- --apply --rotate   also sets a new password for an existing role
// Then in .env: MIGRATE_DATABASE_URL=<the old DATABASE_URL>, DATABASE_URL=<the line from .drishti-app-db-url>, and restart the services.
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const apply = process.argv.includes("--apply");
const rotate = process.argv.includes("--rotate");
const owner = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL!;
const ROLE = "drishti_app";
const FILE = new URL("../.drishti-app-db-url", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const sql = new SQL(owner);
const [me] = (await sql`SELECT current_user AS u, current_database() AS db, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`) as { u: string; db: string; su: boolean }[];
const exists = ((await sql`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`) as unknown[]).length > 0;
console.log(`connected as ${me.u} (${me.su ? "superuser" : "not a superuser"}) to ${me.db}; role ${ROLE} ${exists ? "exists" : "does not exist"}`);
const steps = [
  exists ? (rotate ? "set a new password on the role" : "keep the role's password") : "create the role (LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, a random password)",
  `GRANT CONNECT ON DATABASE ${me.db}; USAGE on schema public`,
  "GRANT SELECT, INSERT, UPDATE, DELETE on every table and USAGE, SELECT on every sequence in schema public",
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${me.u} so tables a later migration creates are covered too`,
];
steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
if (!apply) {
  console.log("Dry run. Nothing changed. Re-run with --apply.");
  await sql.close();
  process.exit(0);
}

let password: string | undefined;
if (!exists || rotate) {
  password = randomBytes(24).toString("hex");
  await sql.unsafe(`${exists ? "ALTER" : "CREATE"} ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
}
await sql.unsafe(`GRANT CONNECT ON DATABASE "${me.db}" TO ${ROLE}`);
await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me.u} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`);
await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me.u} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`);
await sql.close();

if (password) {
  const u = new URL(owner);
  u.username = ROLE;
  u.password = password;
  writeFileSync(FILE, `DATABASE_URL=${u.toString()}\n`, { flag: "w" });
  console.log(`Done. The new connection line is in ${FILE} (git-ignored). Put it in .env as DATABASE_URL and keep the old one as MIGRATE_DATABASE_URL.`);
} else {
  console.log(`Done. Grants refreshed.${existsSync(FILE) ? ` The connection line from the first run is in ${FILE}.` : ""}`);
}
