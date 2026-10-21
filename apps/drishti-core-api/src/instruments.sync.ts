import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { INSTRUMENTS, parseCustomInstrument, setCustomInstruments, type Instrument } from "@drishti/shared";

const EVERY_MS = 30_000;

/**
 * Instruments the user added live in the stream service (it owns the table and the feeds). The API keeps the shared catalogue in step
 * so `SYMBOLS` / `instrument()` validation here accepts them: asked at start and every 30 s. Each entry is validated again; if the stream
 * is down the catalogue is left as it is.
 */
@Injectable()
export class InstrumentSync implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;

  onModuleInit() {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), EVERY_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async sync() {
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.STREAM_PORT ?? 3002}/instruments`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const { instruments } = (await res.json()) as { instruments: (Instrument & { custom?: boolean })[] };
      const accepted: Instrument[] = [];
      const builtins = INSTRUMENTS.filter((i) => !i.custom);
      for (const i of instruments.filter((x) => x.custom)) {
        const r = parseCustomInstrument({ ...i, root: i.symbol.split(":")[1] }, [...builtins, ...accepted]);
        if ("instrument" in r) accepted.push(r.instrument);
      }
      setCustomInstruments(accepted);
    } catch {
      /* stream not up yet: try again next round */
    }
  }
}
