import { Module } from "@nestjs/common";
import { Db } from "./db";
import { MarketController } from "./market.controller";
import { UpstoxController } from "./upstox.controller";

@Module({ controllers: [MarketController, UpstoxController], providers: [Db] })
export class AppModule {}
