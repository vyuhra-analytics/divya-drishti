# Design system spec (step 2, on paper, 2026-10-22)

A dense, calm, one-monitor terminal. It extends the tokens already in `apps/drishti-web/src/styles.css` (`--bg`, `--panel`, `--line`, `--text`, `--muted`, `--up`, `--down`, `--accent`, density via `data-density`, `data-theme`, `data-colors`); it does not replace them. Contrast values below were computed (WCAG ratio) on the dark panel `#131722`; the light theme is out of scope (owner: dark everywhere).

## 1. Principles

1. **State, not decoration.** A colour always means something (direction, favourable, danger, reference, live). Nothing is coloured to look nice.
2. **Never colour alone.** Every state also has a word, shape or position (an arrow, a label, "STOP"), so a colour-blind owner or a glare on the screen loses nothing. The up / down palettes stay switchable (`data-colors`).
3. **The number is the hero.** Prices, premium and rupee P&L are the largest, steadiest type on screen. Labels around them are small and quiet.
4. **Density is spacing, not font size.** Compact and comfortable differ in padding only; the numbers keep their size.
5. **Nothing moves unless the market does.** No animation except a short tick flash on the changing number and the alert styles below.

## 2. Colour tokens (dark first; evening session)

| Token | Value | Contrast on panel | Meaning |
|---|---|---|---|
| `--bg` / `--panel` / `--hover` / `--line` | `#0e1117` / `#131722` / `#1e222d` / `#2a2e39` | n/a | surfaces and hairlines (existing) |
| `--text` | `#d1d4dc` | 12.1 | primary text and numbers |
| `--text-2` (new) | `#aeb3c0` | 8.5 | secondary text |
| `--muted` | `#8a8e9a` | 5.5 | labels, captions (existing) |
| `--up` / `--down` | `#26a69a` / `#ef5350` | 6.0 / 5.1 | price direction (existing, switchable) |
| `--live` (new) | `#4c8dff` | 5.6 | live price, the range box |
| `--good` (new) | `#3fb950` | 7.0 | favourable: in profit, target hit |
| `--bad` (new) | `#ff6b6b` | 6.4 | stop, cap, loss |
| `--warn` (new) | `#f0a020` | 8.3 | time stop, stale data, caution (the existing accent) |
| `--ref` (new) | `#9aa0ac` | 6.8 | reference levels (previous day high / low, VWAP) |

`--up` / `--down` (direction of the market) and `--good` / `--bad` (the owner's position) are **different tokens on purpose**: a falling price is good for a short, so "red" must not mean both. The P&L number uses `--good` / `--bad`; the tick colour uses `--up` / `--down`.

## 3. Type

- UI text: Inter (existing), 12 px for tables and labels, 13 px body (existing base).
- **Numbers: `font-variant-numeric: tabular-nums`** everywhere a price, premium, P&L or time is shown, so columns do not shimmer when digits change. A monospaced face (Cascadia Mono / Consolas / system mono) is used for the chain and any right-aligned column.
- Sizes: **chart price label and the trade block's premium / P&L: 28 px** (the owner reads from arm's length on a large monitor); chart header price 20 px; chain and tables 12 px; section labels 10 px uppercase letter-spaced (existing sidebar pattern).
- Weights: 400 and 500 only on the evening desk; a heavier weight is not needed.

## 4. Space, shape, layers

- 4 px base unit; panel padding from the density token (`--pad` 5 px compact, 9 px comfortable, existing); gaps 8 px between blocks on the evening desk.
- Corners 4 px (panels and buttons), 2 px on chart label chips. No shadows in dark; the light theme keeps the existing 1 px shadow.
- Elevation: three layers only: page (`--bg`), panel (`--panel`), raised (menus, banners: `--hover` plus a `--line` border). At most two floating layers at once (a banner and a menu).

## 5. State language (the same on every panel)

| State | Word | Treatment |
|---|---|---|
| Live | `LIVE` (usually omitted, it is the default) | normal colours |
| Delayed | `DELAYED 10m` | `--warn` badge beside the price; number stays readable |
| Stale | `STALE` + seconds | `--warn` badge, number dimmed to `--text-2` |
| Closed | `CLOSED` | `--muted` badge, number dimmed |
| Disputed | `FEEDS DIFFER` | `--warn` badge with the gap in ticks on hover |
| Demo | `DEMO` | `--bad` badge and the red banner (existing) |
| Outdated (research data) | `OUTDATED` | `--warn` badge (existing) |

## 6. Alerts (evening desk)

Alerts are the one place the screen is allowed to be loud. Four classes, each with a colour, a word, a shape and a sound; none depends on colour alone.

| Class | Triggers | Look | Sound (distinct pattern, not just pitch) |
|---|---|---|---|
| **Critical** | the stop touched, the Rs 2,000 loss cap reached | full-width banner on `#a31621` with white text "STOP (-1R) / LOSS CAP: close the option now", chart border flashes red twice, stays until acknowledged | three descending tones, repeats once after 10 s if unacknowledged |
| **Good** | TP1 or TP2 touched | banner on `#3fb950` with dark text "TP1: move the stop to entry" or "TP2 (+2R): close the option", stays 20 s or until acknowledged | two rising tones |
| **Caution** | the time-stop window opens, entry cut-off passed, feed stale during a trade | amber banner, `#f0a020` with dark text | one medium tone |
| **Info** | the print arrived, a signal formed, the report block updated | slim blue notice, no sound unless enabled | soft click (optional) |

Contrast checked: white on `#a31621` 7.8; dark on amber 8.6; dark on green 7.2; white on `#2f5fd0` 5.7. Banners sit above the chart block, never over the price or the trade block. Sounds are settings (display group); the Critical sound cannot be turned off.

## 7. Components used on the evening desk (to build in step 4)

Stage strip, result gauge (open result in R from -1R to +2R with the stop, TP1 and TP2 marked, and the rupee value), chart header, level label (with rupee equivalent), report block, trimmed chain row (with the suggested-strike highlight and the OI-wall mark), trade block, alert banner, review note box. Each is a small component with props and states listed in the step 3 prototype before it is built.

## 8. Not decided

The light theme values for the new tokens; focus rings on the evening desk (existing global outline stays); sound files; whether the evening desk offers a "dim" mode below `--bg`; the exact flash rate. These need the prototype on the owner's monitor.

## Settled (2026-10-22)

1. **Dark theme everywhere**, evening and research desks. The light theme is not designed for the redesign (the existing one is left in place, untouched, and not part of the acceptance tests).
2. Alert sounds accepted; Critical also flashes the chart border (as specified).
3. No colour read badly.
