// Seal (encrypt) the family records in the database, or take the seal off again.
//   bun run family:seal                 dry run: says how many rows are plain and whether a key exists
//   bun run family:seal -- --apply      creates .drishti-family.key if there is none, then seals every plain row (each is unsealed again and compared before it is saved)
//   bun run family:seal -- --unseal --apply   writes every sealed row back as plain JSON
// BACK UP .drishti-family.key (or set FAMILY_KEY yourself): without the key, sealed rows cannot be read. New imports are sealed automatically once a key exists.
import { SQL } from "bun";
import { isSealed, seal, unseal } from "../packages/shared/src/secretBox";
import { createFamilyKey, loadFamilyKey } from "../packages/shared/src/authNode";

const apply = process.argv.includes("--apply");
const reverse = process.argv.includes("--unseal");
const sql = new SQL(process.env.DATABASE_URL!);
const rows = (await sql`SELECT id, file_name, payload FROM family_imports ORDER BY id`) as { id: number; file_name: string; payload: unknown }[];
const parse = (p: unknown) => (typeof p === "string" ? JSON.parse(p) : p);
const sealed = rows.filter((r) => isSealed(parse(r.payload)));
const plain = rows.filter((r) => !isSealed(parse(r.payload)));
console.log(`${rows.length} stored statements: ${plain.length} plain, ${sealed.length} sealed. Key: ${loadFamilyKey() ? "present" : "none yet"}.`);

if (!apply) {
  console.log(`Dry run. Nothing changed. Re-run with --apply to ${reverse ? "unseal" : "seal"}.`);
  await sql.close();
  process.exit(0);
}

const key = reverse ? loadFamilyKey() : createFamilyKey();
if (!key) throw new Error("there is no key, so nothing can be unsealed");
let done = 0;
for (const r of reverse ? sealed : plain) {
  const p = parse(r.payload);
  const next = reverse ? await unseal(p as never, key) : await seal(p, key);
  const back = reverse ? next : await unseal(next as never, key);
  if (JSON.stringify(back) !== JSON.stringify(reverse ? next : p)) throw new Error(`row ${r.id} did not survive the round trip; nothing further was changed`);
  await sql`UPDATE family_imports SET payload = ${JSON.stringify(next)}::text::jsonb WHERE id = ${r.id}`;
  done++;
}
console.log(`${reverse ? "Unsealed" : "Sealed"} ${done} rows.${reverse ? "" : " Back up .drishti-family.key now."}`);
await sql.close();
