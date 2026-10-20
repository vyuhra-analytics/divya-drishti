import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { RedisClient, SQL } from "bun";

@Injectable()
export class Db implements OnModuleDestroy {
  readonly sql = new SQL(process.env.DATABASE_URL!, { connectionTimeout: 2 });
  readonly redis = new RedisClient(process.env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 2000 });

  async onModuleDestroy() {
    await this.sql.close();
    this.redis.close();
  }
}
