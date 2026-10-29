import { Module } from "@nestjs/common";
import { Db } from "./db";
import { MarketController } from "./market.controller";
import { UpstoxController } from "./upstox.controller";
import { NewsController } from "./news.controller";
import { SessionsController } from "./sessions.controller";
import { OptionsController } from "./options.controller";
import { CostsController } from "./costs.controller";
import { OptionCandlesController } from "./optionCandles.controller";
import { FeedController } from "./feed.controller";
import { EiaHistoryService } from "./eia-history.service";
import { EiaArticleController } from "./eia-article.controller";
import { EiaArticleService } from "./eia-article.service";
import { ForecastService } from "./forecast.service";
import { CalendarController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";
import { EiaReportController } from "./eia-report.controller";
import { EiaReplayController } from "./eia-replay.controller";
import { TimeProfileController } from "./time-profile.controller";
import { FamilyController } from "./family.controller";
import { LabelsController } from "./labels.controller";
import { EiaReportService } from "./eia-report.service";
import { BriefingController } from "./briefing.controller";
import { BriefingFactsController } from "./briefing-facts.controller";
import { CotController } from "./cot.controller";
import { ChokepointsController } from "./chokepoints.controller";
import { CurveController } from "./curve.controller";
import { EiaController } from "./eia.controller";
import { SignalLogController } from "./signal-log.controller";
import { SignalLogService } from "./signal-log.service";
import { CanaryController, CanaryService } from "./canary.controller";
import { ServerAlertsController } from "./server-alerts.controller";
import { PositionsController } from "./positions.controller";
import { InstrumentSync } from "./instruments.sync";
import { AnalysisController } from "./analysis.controller";

@Module({ controllers: [MarketController, UpstoxController, NewsController, SessionsController, OptionsController, CostsController, OptionCandlesController, FeedController, CalendarController, EiaReportController, EiaReplayController, TimeProfileController, EiaArticleController, FamilyController, LabelsController, BriefingController, BriefingFactsController, AnalysisController, PositionsController, CotController, ChokepointsController, CurveController, EiaController, SignalLogController, CanaryController, ServerAlertsController], providers: [Db, CanaryService, InstrumentSync, CalendarService, EiaReportService, EiaHistoryService, EiaArticleService, ForecastService, SignalLogService] })
export class AppModule {}
