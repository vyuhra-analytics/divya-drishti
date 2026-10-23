# Panel cut list (first pass, accepted by the owner 2026-10-22; the owner will change what they disagree with)

All 23 panel types in the registry (`MNEMONICS`) plus the ticker tape. Nothing is deleted by this document; it says where each panel goes in the redesign.

Desks: **Evening** (the one-monitor trading screens, see `EIA_SCREENS.md`) and **Research** (a separate desk the owner opens before or after the evening, never on the trading screen).

| Code | Panel | Decision | Where / change |
|---|---|---|---|
| GP | Chart (advanced) | **Keep, reshape** | Evening: the chart block. Follows the live candle with no zooming, no toolbar chrome, levels drawn by the app. Today's TradingView-like widget stays only for the Research desk. |
| OCX | Option chain | **Keep, reshape** | Evening: trimmed to four strikes and six columns (premium, delta, OI, volume, IV, theta) with the rule's suggested strike. Detailed 15-column view stays on the Research desk. |
| CAL | Calendar | **Keep** | Feeds the report block and the countdown. |
| EIA | EIA stocks | **Keep, reshape** | Becomes the report block (forecast, actual, surprise, allowed side). |
| PT | Paper trading | **Keep, reshape** | Must simulate buying one lot of an option and the R stop, targets and Rs 2,000 cap; today it simulates futures. |
| AL | Alerts | **Keep, reshape** | Alert sounds and flashes at stop, TP1, TP2, the cap and time stop. |
| (status bar) | Status bar | **Keep** | Clocks, sessions, feed ages. |
| Q | Quote | Optional | Price, bid, ask and day range move into the chart header; the panel stays on the Research desk. |
| W | Watchlist | Optional | Research desk. The evening screen shows only the traded instrument. |
| N | News | Optional | Research desk (a one-line headline strip on the evening screen is a later option). |
| TV | Live TV | Keep (owner decision), **Research desk** | Not on the trading screen. |
| CRV | Futures curve | Research desk | |
| COT | Positioning (COT) | Research desk | |
| CHK | Chokepoints | Research desk | |
| RCP | Recap | Research desk | |
| BR | Briefing | Research desk | |
| COST | Costs | Research desk | Needed by paper trading for options costs. |
| BT | Strategy tester | Research desk | To be rebuilt around the owner's real rules (rupee-capped scalp), not generic strategies. |
| DQ | Data quality | Research desk | Feed health stays visible as one line in the status bar. |
| GS | Simple chart | **Cut, deleted** | Duplicate of GP. |
| OC | Option chain (compact) | **Cut, deleted** | Duplicate of OCX. |
| HM | Energy heatmap | **Cut, deleted** | Not used by either strategy. |
| SCR | Energy screener | **Cut, deleted** | Not used by either strategy. |
| INS | Insider trades | **Cut, deleted** | Not used by either strategy. |
| (ticker tape) | Ticker tape | **Cut, deleted** | A scrolling strip is noise on a one-monitor trading screen. |

Counts: keep and reshape 6 + status bar, optional 3, Research desk 9 (including TV), cut 6.

Cut means: removed from the redesigned app, code deleted in its own commit later (as JODI was), after the owner confirms. Layouts saved with a cut panel lose only that panel (the migration used for JODI).
