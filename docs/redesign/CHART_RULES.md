# Chart rules for the evening screen (step 2, on paper, 2026-10-22)

Why this exists: the owner dislikes TradingView because the chart is messy, needs constant zooming in and out to see the current candles, tick and price, and "only offers a live chart". Upstox is the reference: tidy, clean, everything needed. The rules below turn that into testable behaviour. The chart is a **display of the strategy's state**, not a general charting tool.

## 1. What it shows

One instrument (the traded future), **5-minute candles only** (owner: 5-minute is enough, no 1-minute). Nothing else is configured by the user on this screen.

## 2. The live edge (the main requirement)

1. **Auto-follow is the only mode.** The latest candle is always visible, at a fixed position about 80% of the width, with a right margin of 8 empty bars. New candles scroll in; the view never needs to be moved.
2. **Fixed visible window**: the last 48 bars (4 hours) in trade stages, the whole evening from 17:00 (78 bars) in prep. Same window every day, so the picture is familiar.
3. **Price scale fits the visible bars plus the live price**, recomputed on each new candle (not on every tick, so the scale does not breathe). A level outside the fitted range does **not** stretch the scale: it appears as a chip on the axis edge with an arrow and its value.
4. **No zoom or pan by default.** Mouse wheel and drag do nothing in the trade stages. History is a separate, explicit mode (key `H`, or a "History" button) with a visible "LIVE" button and the key `L` that snaps back. Leaving the window for more than 10 seconds returns to live by itself during a trade.
5. **The price is the loudest thing on the chart.** Last price is a large label on the right axis at the live candle's level, coloured by the last tick direction (up / down colour from settings), plus the same number in the chart header. Bid and ask in the header **and in the trade block** (owner); a quote badge (feed, delayed / stale) beside it as today.
6. **The forming candle is visibly the forming candle** (slightly lighter body or an outline) and updates in place on every tick; completed candles are solid.

## 3. Levels the app draws (maximum eight at once)

Priority order; when more than eight apply, the lowest priorities hide, never the top ones:

| Priority | Level | When |
|---|---|---|
| 1 | Entry | in a trade |
| 2 | Stop (future level through delta) and the hard-limit equivalent | in a trade |
| 3 | TP1, TP2, trail | in a trade |
| 4 | Range box high / low (the last hour before the print) | range, print, window, in trade |
| 5 | Previous day high, previous day low | always |
| 6 | Session VWAP | always (thin line) |
| 7 | ~~Open-interest walls~~ | **not drawn** (owner: listed in the chain only); priorities 8 becomes 7 |
| 8 | Report time marker, US open marker | vertical hairline with a small label |

Each level has a **label at the right edge with its value**, labels never overlap (they stack with a leader line), and **trade levels also show the option equivalent**: for example `Stop 8,665 · about -Rs 1,000`. Computed through the option's delta at entry (`EIA_STRATEGY.md`), shown as "about".

## 4. Chrome: almost none

- **No toolbar, no indicator list, no drawing tools, no settings strip, no legend.** One thin header row: instrument, price, bid / ask, spread, day change, feed badge.
- **Crosshair only on hover**, showing time and O / H / L / C; nothing permanent.
- Volume: a thin strip (at most 12% of the height) under the candles; a bar at least **1.5 times the average of the previous ten** is highlighted (the strategies use that test). It can be hidden in settings.
- **Hand-drawn lines**: none (owner confirmed).

## 5. Time and sessions

- Time axis in **IST**, labelled every 30 minutes, with the hour marks stronger.
- Faint vertical hairlines: 17:00 MCX evening open, 19:00 (20:00 after 1 November) US cash open, the report print, and the time-stop window shaded at the right edge in the late stages.
- Gaps (a bar missing in the feed) are shown as a gap, never joined.

## 6. Colour and type

- Colours are state, from the design tokens (step 2 design system): up / down per the user's setting, blue = range and live price, green = favourable, red = stop and limit, grey = reference levels. Not decorative, and the same in light and dark.
- Numbers use a tabular, monospaced face, sized so the price label reads from arm's length on a large monitor (the label at least 28 px high in the default density).

## 7. Performance targets (measured later, step 5)

- A quote reaching the app updates the forming candle and the price label within **100 ms** of arriving in the browser, with no full redraw.
- No visible jump when a new candle starts. No flicker of the price scale.

## 8. Acceptance in trader terms (timed task tests, step 5)

1. Cold start at 19:55: the live candle and price are readable **without touching the mouse**, within 2 seconds of the screen appearing.
2. After four hours with no interaction, the live candle is still in view and the scale still fits.
3. In a trade, every level that matters (entry, stop, TP1, TP2) is visible with its value and its rupee equivalent, **with no zoom**.
4. The owner can say the current price, the nearest level above and below, and the distance to the stop in rupees in under 3 seconds.
5. A reviewer comparing it with Upstox's chart sees no element the owner would call clutter.

## 9. Not a goal

Replacing TradingView for analysis, multiple timeframes on screen, drawing tools, 100 indicators. Those stay on the Research desk (today's advanced chart), where zooming is welcome.

## Settled (2026-10-22)

5-minute only; no hand-drawn lines; OI walls listed in the chain, not drawn; 4-hour window in trade stages; bid / ask in both the chart header and the trade block. Nothing open.
