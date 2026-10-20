import { Module } from "@nestjs/common";
import { Db } from "./db";
import { MarketController } from "./market.controller";

@Module({ controllers: [MarketController], providers: [Db] })
export class AppModule {}
