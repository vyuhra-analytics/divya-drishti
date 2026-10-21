import { Module } from "@nestjs/common";
import { Db } from "./db";
import { MarketController } from "./market.controller";
import { UpstoxController } from "./upstox.controller";
import { NewsController } from "./news.controller";
import { SessionsController } from "./sessions.controller";
import { OptionsController } from "./options.controller";
import { InsiderController } from "./insider.controller";
import { CalendarController } from "./calendar.controller";
import { BriefingController } from "./briefing.controller";
import { CotController } from "./cot.controller";
import { ChokepointsController } from "./chokepoints.controller";
import { CurveController } from "./curve.controller";
import { JodiController } from "./jodi.controller";
import { EiaController } from "./eia.controller";
import { CanaryController, CanaryService } from "./canary.controller";
import { PositionsController } from "./positions.controller";

@Module({ controllers: [MarketController, UpstoxController, NewsController, SessionsController, OptionsController, InsiderController, CalendarController, BriefingController, PositionsController, CotController, ChokepointsController, CurveController, JodiController, EiaController, CanaryController], providers: [Db, CanaryService] })
export class AppModule {}
