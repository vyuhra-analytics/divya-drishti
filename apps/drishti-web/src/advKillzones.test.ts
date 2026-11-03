import { expect, test } from "bun:test";
import { KILLZONES_ID, killzoneIndicator, registerKillzones, withAlpha } from "./advKillzones";

const edt = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 + 4 * 3600;
const bar = (time: number, p: number) => ({ time, open: p, high: p + 1, low: p - 1, close: p });
const settings = (over: Record<string, unknown> = {}) => ({ ...Object.fromEntries(killzoneIndicator().inputs.map((i) => [i.key, i.default])), ...over });

test("shades each bar by the killzone it opens in, in that zone's colour, and leaves the rest clear", () => {
  const d = killzoneIndicator();
  const bars = [bar(edt("2026-10-21", "03:00"), 1), bar(edt("2026-10-21", "06:00"), 2), bar(edt("2026-10-21", "10:30"), 3), bar(edt("2026-10-21", "14:00"), 4)];
  const bg = d.background!({ bars, values: {}, settings: settings() }) as (string | null)[];
  expect(bg[0]).toBe(withAlpha("#42a5f5", 0.14)); // London
  expect(bg[1]).toBeNull(); // between London and New York AM
  expect(bg[2]).toBe(withAlpha("#ab47bc", 0.14)); // London close: the 10:30 EIA release
  expect(bg[3]).toBe(withAlpha("#66bb6a", 0.14)); // New York PM
});

test("a zone switched off, or recoloured, in the settings follows the settings", () => {
  const d = killzoneIndicator();
  const bars = [bar(edt("2026-10-21", "03:00"), 1), bar(edt("2026-10-21", "08:00"), 2)];
  const bg = d.background!({ bars, values: {}, settings: settings({ show_london: false, color_nyam: "#ff0000" }) }) as (string | null)[];
  expect(bg[0]).toBeNull();
  expect(bg[1]).toBe("rgba(255, 0, 0, 0.14)");
});

test("the levels follow their switches and are as long as the bars", () => {
  const d = killzoneIndicator();
  const bars = Array.from({ length: 30 }, (_, i) => bar(edt("2026-10-21", "00:00") + i * 300, 100 + i));
  const on = d.calc(bars, settings(), {});
  expect(on.midnight).toHaveLength(30);
  expect(on.midnight[5]).toBe(100); // the open of the 00:00 bar
  const off = d.calc(bars, settings({ show_midnight: false, show_asia: false }), {});
  expect(off.midnight.every((v) => v === null)).toBe(true);
  expect(off.asiaHigh.every((v) => v === null)).toBe(true);
});

test("registers once, and a registration that throws leaves the chart alone", () => {
  const seen: string[] = [];
  registerKillzones((d) => seen.push(d.id), (id) => seen.includes(id));
  registerKillzones((d) => seen.push(d.id), (id) => seen.includes(id));
  expect(seen).toEqual([KILLZONES_ID]);
  expect(() => registerKillzones(() => { throw new Error("nope"); }, () => false)).not.toThrow();
});

test("withAlpha turns a hex colour into rgba and leaves anything else alone", () => {
  expect(withAlpha("#ffa726", 0.5)).toBe("rgba(255, 167, 38, 0.5)");
  expect(withAlpha("red", 0.5)).toBe("red");
});

test("Power of 3 markers: a London sweep of the Asian high that closes back inside is a red arrow down on the confirming bar; switched off, none", () => {
  const d = killzoneIndicator();
  const bars = [];
  for (let i = 0; i < 48; i++) bars.push(i % 2 ? { time: edt("2026-10-20", "20:00") + i * 300, open: 105, high: 110, low: 100, close: 105 } : bar(edt("2026-10-20", "20:00") + i * 300, 105));
  for (let t = edt("2026-10-21", "00:00"); t < edt("2026-10-21", "04:00"); t += 300) bars.push(t === edt("2026-10-21", "03:00") ? { time: t, open: 108, high: 112, low: 107, close: 109 } : bar(t, 105));
  const marks = d.markers!({ bars, values: {}, settings: settings() }) as unknown as { time: number; position: string; shape: string; text?: string }[];
  expect(marks).toHaveLength(1);
  expect(marks[0]).toMatchObject({ time: edt("2026-10-21", "03:00"), position: "aboveBar", shape: "arrowDown", text: "PO3 swept high" });
  expect(d.markers!({ bars, values: {}, settings: settings({ show_po3: false }) })).toEqual([]);
  expect(d.markerAnchor).toBe("price");
});

test("zone boxes name each killzone of the latest days with its high, low, range and average, and none when set to 0", () => {
  const d = killzoneIndicator();
  const bars = [];
  for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) for (let t = edt(day, "07:00"); t < edt(day, "10:00"); t += 60) bars.push({ time: t, open: 100, high: day === "2026-10-22" ? 104 : 101, low: day === "2026-10-22" ? 98 : 99, close: 100 });
  const boxes = d.draws!({ bars, values: {}, settings: settings({ box_days: 2, show_day_levels: false, zone_levels: false }) }) as unknown as { kind: string; from: { time: number; price: number }; to: { time: number; price: number }; text?: string; at?: { time: number; price: number }; verticalAlign?: string }[];
  expect(boxes).toHaveLength(4); // the latest two days only: a box and its name plate each
  const last = boxes[2];
  const plate = boxes[3];
  expect(last.kind).toBe("box");
  expect(last.from).toEqual({ time: edt("2026-10-22", "07:00"), price: 104 });
  expect(last.to).toEqual({ time: edt("2026-10-22", "10:00"), price: 98 });
  expect(last.text).toBeUndefined(); // nothing inside the box
  expect(plate.kind).toBe("label");
  expect(plate.at).toEqual({ time: edt("2026-10-22", "07:00"), price: 104 }); // on the box's top edge
  expect(plate.verticalAlign).toBe("bottom"); // above it
  expect(plate.text).toBe(["New York AM  16:30-19:30 IST", "H 104  L 98", "Range 6  Avg 100"].join("\n"));
  expect(d.draws!({ bars, values: {}, settings: settings({ box_days: 0, show_day_levels: false, zone_levels: false }) })).toEqual([]);
  expect(d.draws!({ bars, values: {}, settings: settings({ box_days: 2, show_nyam: false, show_day_levels: false, zone_levels: false }) })).toEqual([]);
});

test("london_open anchors the London zone to London's 07:00-10:00 and labels the settings in Indian time", () => {
  const d = killzoneIndicator();
  const utcBar = (iso: string, p: number) => bar(Date.parse(`${iso}Z`) / 1000, p);
  // 28 Oct 2026: London is on winter time, New York still on summer time
  const bars = [utcBar("2026-10-28T06:30:00", 1), utcBar("2026-10-28T09:30:00", 2)]; // 02:30 and 05:30 New York
  const ny = d.background!({ bars, values: {}, settings: settings() }) as (string | null)[];
  expect([ny[0] !== null, ny[1] !== null]).toEqual([true, false]);
  const ldn = d.background!({ bars, values: {}, settings: settings({ london_open: true }) }) as (string | null)[];
  expect([ldn[0] !== null, ldn[1] !== null]).toEqual([false, true]);
  expect(d.inputs.find((i) => i.key === "show_london")!.label).toMatch(/IST/);
});

test("day levels: today's and the previous day's high and low start at their own day, and the switch turns them off", async () => {
  const { dayLines } = await import("./advKillzones");
  const T0 = Date.parse("2026-10-20T04:00:00Z") / 1000;
  const mk = (n: number, hi: number, lo: number) => Array.from({ length: 6 }, (_, i) => ({ time: T0 + n * 86400 + i * 300, open: 100, high: i === 2 ? hi : hi - 1, low: i === 3 ? lo : lo + 1, close: 100 }));
  const bars = [...mk(0, 500, 400), ...mk(1, 110, 90), ...mk(2, 120, 95)];
  const lines = dayLines(bars, settings()) as { kind: string; from: { time: number; price: number }; to: { time: number } }[];
  const l = lines.filter((x) => x.kind === "line");
  expect(l.map((x) => x.from.price)).toEqual([110, 90, 120, 95]);
  expect(l[0].from.time).toBe(T0 + 86400); // previous day starts where it started, not at the chart's left edge
  expect(l[0].to.time).toBe(l[2].to.time); // and runs on through today by default
  expect((dayLines(bars, settings({ extend_prev: false })) as typeof lines).filter((x) => x.kind === "line")[0].to.time).toBe(T0 + 86400 + 6 * 300);
  expect(dayLines(bars, settings({ show_day_levels: false }))).toEqual([]);
});

test("zone levels: each killzone's high and low for the previous day and today run from the zone's start to the newest candle; the switch turns them off", async () => {
  const { zoneLines } = await import("./advKillzones");
  const bars: { time: number; open: number; high: number; low: number; close: number }[] = [];
  for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) for (let t = edt(day, "07:00"); t < edt(day, "10:00"); t += 60) bars.push({ time: t, open: 100, high: day === "2026-10-22" ? 104 : 101, low: day === "2026-10-22" ? 98 : 99, close: 100 });
  const lines = (zoneLines(bars, settings()) as { kind: string; from: { time: number; price: number }; to: { time: number }; lineStyle: string }[]).filter((x) => x.kind === "line");
  expect(lines).toHaveLength(4); // New York AM of the previous day and of today, high and low each (the day before is not drawn)
  expect(lines.map((l) => l.from.price)).toEqual([101, 99, 104, 98]);
  expect(lines[0].lineStyle).toBe("dashed");
  expect(lines[2].lineStyle).toBe("solid");
  expect(lines[2].from.time).toBe(edt("2026-10-22", "07:00"));
  expect(lines[0].to.time).toBe(bars[bars.length - 1].time + 60);
  expect(zoneLines(bars, settings({ zone_levels: false }))).toEqual([]);
});
