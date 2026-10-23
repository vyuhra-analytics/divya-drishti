import { describe, expect, it } from "bun:test";
import { crudeTone } from "./crudeLexicon";

describe("crude price-direction tone", () => {
  it("scores bullish headlines above zero", () => {
    for (const t of ["Oil prices jump as OPEC+ agrees to deepen output cuts", "Crude surges after drone attack on Saudi refinery", "US crude inventories fall by 5 million barrels", "Brent rallies on supply disruption fears in Libya", "Oil climbs as tensions escalate near the Strait of Hormuz"])
      expect([t, crudeTone(t).tone > 0]).toEqual([t, true]);
  });

  it("scores bearish headlines below zero", () => {
    for (const t of ["Oil prices slump as demand worries mount", "Brent falls on global glut and weak demand", "US crude stockpiles rise more than expected", "Oil slides after ceasefire raises hopes of resumed exports", "WTI tumbles as OPEC raises output"])
      expect([t, crudeTone(t).tone < 0]).toEqual([t, true]);
  });

  it("reads inventory direction, which flips the sign of the same noun: a draw is bullish, a build bearish", () => {
    expect(crudeTone("Crude inventories fell last week").tone).toBeGreaterThan(0);
    expect(crudeTone("Crude inventories rose last week").tone).toBeLessThan(0);
  });

  it("scores a headline with no direction word as zero and keeps the score in range", () => {
    expect(crudeTone("OPEC secretary general to speak at conference").tone).toBe(0);
    expect(crudeTone("").tone).toBe(0);
    const all = crudeTone("Oil surges and jumps and rallies as supply disruption, attack on tankers and tensions escalate");
    expect(all.tone).toBeLessThanOrEqual(1);
    expect(all.tone).toBeGreaterThan(0.5);
  });

  it("an attack on tankers is bullish for the PRICE although its general tone is negative (the reason for a crude list)", () => {
    expect(crudeTone("Iran: 7 oil tankers attacked in the Strait of Hormuz").tone).toBeGreaterThan(0);
  });

  it("counts each pattern once per headline, so repetition does not inflate the tone", () => {
    expect(crudeTone("Oil jumps, jumps, jumps").bullish).toBe(1);
  });
});
