import { expect, test } from "bun:test";
import protobuf from "protobufjs";
import { join } from "node:path";
import { instrument } from "@drishti/shared";
import { feedToQuotes } from "./upstox";

const targets = new Map([["MCX_FO|573422", { inst: instrument("MCX:CRUDEOIL")!, contract: "CRUDEOIL FUT 19 NOV 26" }]]);

test("feedToQuotes maps a full-mode market feed (round-tripped through the real proto)", () => {
  const FeedResponse = protobuf
    .loadSync(join(import.meta.dir, "MarketDataFeed.proto"))
    .lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
  const payload = {
    type: 1,
    currentTs: 1792516000000,
    feeds: {
      "MCX_FO|573422": {
        fullFeed: {
          marketFF: {
            ltpc: { ltp: 9335, ltt: 1792515999000, ltq: 2, cp: 9456 },
            marketOHLC: { ohlc: [{ interval: "1d", open: 9596, high: 9661, low: 9063, close: 9335, vol: 45900 }, { interval: "I1", open: 9330, high: 9336, low: 9329, close: 9335 }] },
            marketLevel: { bidAskQuote: [{ bidQ: 3, bidP: 9334, askQ: 5, askP: 9336 }, { bidQ: 9, bidP: 9333, askQ: 1, askP: 9337 }] },
            vtt: 45900,
            oi: 13304,
            atp: 9345.5,
            tbq: 1200,
            tsq: 900,
          },
        },
      },
      "MCX_FO|999": { ltpc: { ltp: 1 } }, // not ours
    },
  };
  const wire = FeedResponse.encode(FeedResponse.fromObject(payload)).finish();
  const msg = FeedResponse.toObject(FeedResponse.decode(wire), { longs: Number });

  expect(feedToQuotes(msg, targets)).toEqual([
    {
      symbol: "MCX:CRUDEOIL",
      price: 9335,
      time: 1792515999000,
      prevClose: 9456,
      open: 9596,
      high: 9661,
      low: 9063,
      volume: 45900,
      bid: 9334,
      ask: 9336,
      bidQty: 3,
      askQty: 5,
      oi: 13304,
      atp: 9345.5,
      totalBuyQty: 1200,
      totalSellQty: 900,
      contract: "CRUDEOIL FUT 19 NOV 26",
      source: "upstox",
      delayedBy: 0,
    },
  ]);
});

test("feedToQuotes handles ltpc-only feeds and ignores empty ones", () => {
  const q = feedToQuotes({ feeds: { "MCX_FO|573422": { ltpc: { ltp: 9300, ltt: 5, cp: 9400 } } } }, targets);
  expect(q[0]).toMatchObject({ price: 9300, time: 5, prevClose: 9400, volume: undefined });
  expect(feedToQuotes({ feeds: { "MCX_FO|573422": {} } }, targets)).toEqual([]);
  expect(feedToQuotes({}, targets)).toEqual([]);
});
