import { Module } from "@nestjs/common";
import { Db } from "./db";
import { MarketController } from "./market.controller";
import { UpstoxController } from "./upstox.controller";
import { NewsController } from "./news.controller";

@Module({ controllers: [MarketController, UpstoxController, NewsController], providers: [Db] })
export class AppModule {}
