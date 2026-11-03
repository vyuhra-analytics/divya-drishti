import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import compression from "compression";
import type { NextFunction, Request, Response } from "express";
import { allowedHosts, allowedOrigins, guard, RateLimiter, TOKEN_HEADER } from "@drishti/shared";
import { loadTokens } from "../../../packages/shared/src/authNode";
import { AppModule } from "./app.module";

const PORT = Number(process.env.API_PORT ?? 3001);
// Localhost only by default: a personal terminal shouldn't be reachable from the LAN. Set HOST=0.0.0.0 deliberately.
const HOST = process.env.HOST ?? "127.0.0.1";
const origins = allowedOrigins(process.env.WEB_ORIGINS);
const limiter = new RateLimiter(600, 60_000);
const writeLimiter = new RateLimiter(120, 60_000); // changes (POST, PATCH, PUT, DELETE) are far rarer than reads, so a runaway loop of them is stopped sooner // a full workspace load is ~10 requests; 600/min only stops runaways

const tokens = loadTokens();
if (!tokens) console.warn("DRISHTI_AUTH=off: the API answers any local caller without a token. Use this only to debug.");
const hosts = allowedHosts(process.env.ALLOWED_HOSTS);

const app = await NestFactory.create(AppModule);
// access control comes first, before CORS, the upload reader and everything else: a request must name one of our hosts, come from an allowed origin (or none) and
// carry the token. The caller kind (ui or mcp) is set from the token it presented, never from a header it chose.
app.use((req: Request, res: Response, next: NextFunction) => {
  const verdict = guard(
    { method: req.method, path: req.path, host: req.headers.host, origin: req.headers.origin, token: req.header(TOKEN_HEADER) },
    { hosts, origins, tokens, publicPaths: ["/auth/upstox/callback"] }, // Upstox sends the browser here after the login; the one-time state protects it
  );
  if (verdict.ok) {
    (req as Request & { callerKind?: string }).callerKind = verdict.kind;
    return next();
  }
  res.status(verdict.status).json({ statusCode: verdict.status, message: verdict.message });
});
app.enableCors({ origin: origins }); // only our web app / Tauri may read responses in a browser
// a broker statement upload: the .xlsx bytes as they are, collected here because the JSON parser would ignore them (and `express` is not a direct dependency to import a raw parser from)
const UPLOAD_MAX = 30 * 1024 * 1024;
app.use("/family/import", (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST") return next();
  // the bytes only: a browser can send text/plain or a form from any page without asking permission first, so those types are not accepted here
  if (req.headers["content-type"] !== "application/octet-stream") return void res.status(415).json({ statusCode: 415, message: "send the file as application/octet-stream" });
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > UPLOAD_MAX) {
      req.destroy();
      if (!res.headersSent) res.status(413).json({ statusCode: 413, message: "the file is too big to be a broker statement" });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    (req as Request & { body: unknown }).body = Buffer.concat(chunks);
    next();
  });
  req.on("error", next);
});
app.use(compression()); // chart history is ~450 KB of JSON uncompressed
// one line per change (who, what, the answer; never a body): the API had no record of writes, only the paper engine did
const WRITES = new Set(["POST", "PATCH", "PUT", "DELETE"]);
app.use((req: Request, res: Response, next: NextFunction) => {
  if (WRITES.has(req.method)) {
    const kind = (req as Request & { callerKind?: string }).callerKind ?? "?";
    res.on("finish", () => console.log(JSON.stringify({ audit: "api", at: new Date().toISOString(), caller: kind, method: req.method, path: req.path, status: res.statusCode })));
  }
  next();
});
app.use((req: Request, res: Response, next: NextFunction) => {
  // keyed by who is calling (the ui token or the agent's) as well as the address: on one machine every caller shares 127.0.0.1, and one noisy client must not lock the others out
  const key = `${(req as Request & { callerKind?: string }).callerKind ?? "?"}:${req.ip ?? "unknown"}`;
  if (WRITES.has(req.method) && !writeLimiter.take(key)) {
    res.setHeader("Retry-After", Math.ceil(writeLimiter.retryAfterMs(key) / 1000));
    return void res.status(429).json({ statusCode: 429, message: "Too many changes" });
  }
  if (limiter.take(key)) return next();
  res.setHeader("Retry-After", Math.ceil(limiter.retryAfterMs(key) / 1000));
  res.status(429).json({ statusCode: 429, message: "Too many requests" });
});
if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) console.warn(`HOST=${HOST}: the API is reachable from other machines. The token still protects it, but add ALLOWED_HOSTS for the names you use and keep the token secret.`);
await app.listen(PORT, HOST);
console.log(`drishti-core-api on http://${HOST}:${PORT}`);
