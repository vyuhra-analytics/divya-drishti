import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { RedisClient, SQL } from "bun";
import { REDIS_OPTIONS } from "@drishti/shared";

@Injectable()
export class Db implements OnModuleDestroy {
  readonly sql = new SQL(process.env.DATABASE_URL!, { connectionTimeout: 2 });
  readonly redis = new RedisClient(process.env.REDIS_URL, REDIS_OPTIONS);

  async onModuleDestroy() {
    await this.sql.close();
    this.redis.close();
  }
}
