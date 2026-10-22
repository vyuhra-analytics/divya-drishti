import { create } from "zustand";
import { dedupeNews, SYMBOLS, type MarketStatus, type NewsItem, type OptionQuote, type Quote } from "@drishti/shared";
import { useAlerts } from "./alertsStore";
import { streamUrl } from "./settings";
import { pushTrail } from "./spark";

/** Live market data. UI/layout state lives in workspace.ts. */
interface MarketState {
  status: "connecting" | "open" | "closed";
  /** latest provider snapshot per symbol (price, day OHLC, volume, contract, source) */
  quotes: Record<string, Quote>;
  /** recent distinct prices per symbol this session, for sparklines */
  trail: Record<string, number[]>;
  /** previous price per symbol, for tick-direction colouring */
  prev: Record<string, number>;
  /** energy headlines, newest first (pushed by the stream service) */
  news: NewsItem[];
  /** the exchange's own MCX status from Upstox (heartbeat); the session rules decide when it is missing or old */
  mcxStatus?: MarketStatus;
  /** live option quotes by Upstox instrument key, for the contracts a panel asked the stream to watch (see optionFeed.ts) */
  options: Record<string, OptionQuote>;
  /** +1 on every (re)connect: charts re-fetch history so candles missed while disconnected get filled */
  epoch: number;
  /** per symbol: when the server last heard from its active source (heartbeat), for STALE detection */
  seen: Record<string, number>;
  /** +1 whenever the server says a paper account changed (a trade from any client, an agent over MCP, a stop firing): the Paper panel re-reads */
  paperRev: number;
  /** +1 when an agent (Claude over MCP) submits a briefing: the Briefing panel re-reads what was submitted */
  briefingRev: number;
  /** +1 when the tracked instruments change (one added or removed in Settings, here or in another tab): the app remounts so every list and picker re-reads SYMBOLS */
  instrumentsRev: number;
}

export const useStore = create<MarketState>()(() => ({
  status: "connecting",
  quotes: {},
  trail: {},
  prev: {},
  news: [],
  mcxStatus: undefined,
  options: {},
  epoch: 0,
  seen: {},
  paperRev: 0,
  instrumentsRev: 0,
  briefingRev: 0,
}));

// The stream sends a heartbeat every 15 s. A socket can die without a close event (laptop sleep, Wi-Fi switch,
// proxy idle timeout) and would otherwise show frozen prices forever; after 45 s of silence, reconnect.
const SILENCE_MS = 45_000;
let lastMessageAt = 0;
setInterval(() => {
  if (useStore.getState().status === "open" && Date.now() - lastMessageAt > SILENCE_MS) reconnect();
}, 5_000);

let ws: WebSocket | undefined;

/** Tell the stream which option contracts this tab shows (it drops one nobody has asked for in 60 s); ignored while the socket is down. */
export function sendWatch(keys: string[]) {
  if (ws?.readyState === WebSocket.OPEN && keys.length) ws.send(JSON.stringify({ watch: keys }));
}

export function connectStream() {
  useStore.setState({ status: "connecting" });
  const sock = new WebSocket(streamUrl());
  ws = sock;
  sock.onopen = () => {
    lastMessageAt = Date.now();
    useStore.setState((s) => ({ status: "open", epoch: s.epoch + 1 }));
    sock.send(JSON.stringify({ subscribe: [...SYMBOLS, "news", "alerts", "paper", "briefing", "options"] }));
  };
  sock.onmessage = (e) => {
    lastMessageAt = Date.now();
    const msg: Quote | { type: "news"; items: NewsItem[] } | { type: "hb"; seen?: Record<string, number>; mcxStatus?: MarketStatus | null } | { type: "opt"; q: OptionQuote } | { type: "alert"; id: string; message: string } | { type: "paper"; account: string; event: string; actor: string; text: string } | { type: "briefing"; id: string; symbol: string; bias: string; verified: number; total: number; wrong: number } =
      JSON.parse(e.data);
    if ("type" in msg) {
      // a server-side alert fired (it also went to Telegram/webhook): show it here too
      if (msg.type === "alert") useAlerts.getState().push(msg.id, msg.message);
      // a paper account changed on the server: the panel re-reads; changes this tab did not make itself (an agent over MCP, a stop firing) also get a notice
      if (msg.type === "paper") {
        useStore.setState((s) => ({ paperRev: s.paperRev + 1 }));
        if (msg.actor !== "ui") useAlerts.getState().push("paper", msg.text);
      }
      // an agent submitted a briefing: the panel re-reads, and every open browser shows a notice
      if (msg.type === "briefing") {
        useStore.setState((s) => ({ briefingRev: s.briefingRev + 1 }));
        useAlerts.getState().push(`briefing-${msg.id}`, `Claude wrote a ${msg.bias} briefing on ${msg.symbol.split(":")[1]}: ${msg.verified} of ${msg.total} points checked against the data${msg.wrong ? `, ${msg.wrong} contradict it` : ""}`);
      }
      if (msg.type === "opt" && msg.q?.key) useStore.setState((s) => ({ options: { ...s.options, [msg.q.key]: msg.q } }));
      if (msg.type === "news") useStore.setState((s) => ({ news: dedupeNews(s.news, msg.items) }));
      if (msg.type === "hb" && msg.seen) useStore.setState((s) => ({ seen: { ...s.seen, ...msg.seen }, mcxStatus: msg.mcxStatus ?? undefined }));
      return;
    }
    const q = msg;
    useStore.setState((s) => ({
      seen: { ...s.seen, [q.symbol]: Date.now() },
      quotes: { ...s.quotes, [q.symbol]: q },
      trail: { ...s.trail, [q.symbol]: pushTrail(s.trail[q.symbol], q.price) },
      prev: { ...s.prev, [q.symbol]: s.quotes[q.symbol]?.price ?? q.price },
    }));
  };
  sock.onclose = () => {
    if (ws !== sock) return; // replaced by reconnect()
    useStore.setState({ status: "closed" });
    setTimeout(() => ws === sock && connectStream(), 1000);
  };
}

/** Ask the stream for every tracked symbol again (after one was added); symbols already subscribed just get their snapshot re-sent. */
export function resubscribeSymbols() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ subscribe: [...SYMBOLS] }));
}

/** Drop the current socket and connect again (e.g. after the stream URL changed). */
export function reconnect() {
  const old = ws;
  ws = undefined;
  old?.close();
  connectStream();
}
