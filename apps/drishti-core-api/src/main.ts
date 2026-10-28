import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import compression from "compression";
import type { NextFunction, Request, Response } from "express";
import { allowedOrigins, RateLimiter } from "@drishti/shared";
import { AppModule } from "./app.module";

const PORT = Number(process.env.API_PORT ?? 3001);
// Localhost only by default: a personal terminal shouldn't be reachable from the LAN. Set HOST=0.0.0.0 deliberately.
const HOST = process.env.HOST ?? "127.0.0.1";
const origins = allowedOrigins(process.env.WEB_ORIGINS);
const limiter = new RateLimiter(600, 60_000); // a full workspace load is ~10 requests; 600/min only stops runaways

const app = await NestFactory.create(AppModule);
app.enableCors({ origin: origins }); // only our web app / Tauri may read responses in a browser
// a broker statement upload: the .xlsx bytes as they are, collected here because the JSON parser would ignore them (and `express` is not a direct dependency to import a raw parser from)
const UPLOAD_MAX = 30 * 1024 * 1024;
app.use("/family/import", (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST") return next();
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
app.use((req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? "unknown";
  if (limiter.take(key)) return next();
  res.setHeader("Retry-After", Math.ceil(limiter.retryAfterMs(key) / 1000));
  res.status(429).json({ statusCode: 429, message: "Too many requests" });
});
await app.listen(PORT, HOST);
console.log(`drishti-core-api on http://${HOST}:${PORT}`);
