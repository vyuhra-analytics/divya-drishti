// Server-side half of access control (reads and creates the token file). Imported by path from the Bun services, scripts and the MCP server; NOT exported from the
// package index, because the web app imports that and must never bundle `node:fs`.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_HEADER, type Tokens } from "./auth";
import { newKey } from "./secretBox";

/** The repository root, whatever directory a process was started from. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TOKEN_FILE = join(ROOT, ".drishti-tokens.json");

const fresh = () => randomBytes(32).toString("hex");

/**
 * The two access tokens. DRISHTI_TOKEN / DRISHTI_MCP_TOKEN win when set; otherwise they are read from `.drishti-tokens.json` in the repository root (git-ignored),
 * which the first service to start creates. The file is created with the exclusive flag, so two services starting together cannot write different secrets.
 * Returns null when DRISHTI_AUTH=off (host and origin are still checked, but nothing needs a token: for debugging only).
 */
export function loadTokens(env: Record<string, string | undefined> = process.env, file = TOKEN_FILE): Tokens | null {
  if (env.DRISHTI_AUTH === "off") return null;
  const fromEnv = { ui: env.DRISHTI_TOKEN?.trim() ?? "", mcp: env.DRISHTI_MCP_TOKEN?.trim() ?? "" };
  if (fromEnv.ui && fromEnv.mcp) return fromEnv;
  let stored: Partial<Tokens> = {};
  if (!existsSync(file)) {
    try {
      writeFileSync(file, JSON.stringify({ ui: fresh(), mcp: fresh() }, null, 2), { flag: "wx" });
    } catch {
      /* another process created it a moment ago */
    }
  }
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Tokens>;
  } catch {
    /* unreadable: use the environment values, and a random secret nobody holds for the rest (fails closed) */
  }
  return { ui: fromEnv.ui || stored.ui || fresh(), mcp: fromEnv.mcp || stored.mcp || fresh() };
}

/** Headers our own services (and scripts) add to calls to the API and the stream. `kind` picks which token to present. */
export function internalHeaders(kind: "ui" | "mcp" = "ui", env: Record<string, string | undefined> = process.env): Record<string, string> {
  const t = loadTokens(env);
  return t ? { [TOKEN_HEADER]: t[kind] } : {};
}

export const FAMILY_KEY_FILE = join(ROOT, ".drishti-family.key");

/**
 * The key that seals the family records (broker statements) in the database, or undefined when sealing is not switched on: FAMILY_KEY in the environment, or the
 * key file. Reading never creates a key; `createFamilyKey()` does, once, when you choose to start sealing (`bun run family:seal`). Back the key up: without it the sealed rows cannot be read.
 */
export function loadFamilyKey(env: Record<string, string | undefined> = process.env, file = FAMILY_KEY_FILE): string | undefined {
  const fromEnv = env.FAMILY_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Creates the key file (exclusive: never overwrites a key that sealed data) and returns the key now in force. */
export function createFamilyKey(file = FAMILY_KEY_FILE): string {
  try {
    writeFileSync(file, newKey(), { flag: "wx" });
  } catch {
    /* it exists already: keep it */
  }
  return readFileSync(file, "utf8").trim();
}
