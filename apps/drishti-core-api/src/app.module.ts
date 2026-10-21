import { Module } from "@nestjs/common";
import { Db } from "./db";
import { MarketController } from "./market.controller";
import { UpstoxController } from "./upstox.controller";
import { NewsController } from "./news.controller";
import { SessionsController } from "./sessions.controller";
import { OptionsController } from "./options.controller";
import { InsiderController } from "./insider.controller";
import { CalendarController } from "./calendar.controller";

@Module({ controllers: [MarketController, UpstoxController, NewsController, SessionsController, OptionsController, InsiderController, CalendarController], providers: [Db] })
export class AppModule {}
