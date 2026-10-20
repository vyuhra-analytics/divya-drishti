import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule);
app.enableCors(); // web dev server + Tauri webview origins
await app.listen(Number(process.env.API_PORT ?? 3001));
console.log(`drishti-core-api on :${process.env.API_PORT ?? 3001}`);
