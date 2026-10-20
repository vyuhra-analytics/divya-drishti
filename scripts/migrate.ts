import { SQL } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../infra/sql");
const sql = new SQL(process.env.DATABASE_URL!);
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await sql.file(join(dir, file));
  console.log(`applied ${file}`);
}
await sql.close();
