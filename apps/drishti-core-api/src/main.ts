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
app.use(compression()); // chart history is ~450 KB of JSON uncompressed
app.use((req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? "unknown";
  if (limiter.take(key)) return next();
  res.setHeader("Retry-After", Math.ceil(limiter.retryAfterMs(key) / 1000));
  res.status(429).json({ statusCode: 429, message: "Too many requests" });
});
await app.listen(PORT, HOST);
console.log(`drishti-core-api on http://${HOST}:${PORT}`);
