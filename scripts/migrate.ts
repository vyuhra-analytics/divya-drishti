import { SQL } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../infra/sql");
// migrations need the owner (CREATE EXTENSION, CREATE TABLE); the services may run as a least-privilege role (see scripts/db-harden.ts)
const sql = new SQL((process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL)!);
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await sql.file(join(dir, file));
  console.log(`applied ${file}`);
}
await sql.close();
