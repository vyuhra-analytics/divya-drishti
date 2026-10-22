# EIA-day prototype (step 3)

`eia-replay.html` is one self-contained page (data inline, no server, open it in a browser). It replays the real 5-minute bars of **7 Oct 2026** (17:00 to 23:30 IST) through the EIA-day screen designed in `../EIA_SCREENS.md`, `../CHART_RULES.md`, `../SETTINGS.md` and `../DESIGN_SYSTEM.md`. `eia-replay.template.html` is the source; the build is a one-line replace of `/*DATA*/null` with `day-2026-10-07.json`.

**Real:** the 5-minute bars, the previous-day high and low (8,594 / 8,341), the last-hour range, the signal rule and the alerts logic.
**Simulated, and labelled on screen:** ticks inside each bar (a path through open, low, high, close), bid / ask, the option premium and the chain numbers (a Bachelier model with at-the-money premium about 5.7% of the future and a Rs 1.4 spread, which matches the live crude spread), OI, volume, IV, theta.
**Typed in, illustrative:** the EIA forecast and actual (no forecast history is stored). The defaults give a +3.7M surprise, so only a short is allowed.

Controls: Play / Pause, speed 1x 10x 60x, jump buttons, "I bought it" / "I sold it" (exits are by hand), Reset day, a timed-task stopwatch.

Rules running: range = high and low of 19:00 to 20:00; a 5-minute close beyond it between the print and 30 minutes after, on an allowed side; entry reference = the next future open; R = 1.5 x ATR(14); stop -1R, TP1 +1R (then the stop moves to entry), TP2 +2R; a Rs 2,000 cap on the loss of one trade (a lower-delta strike is suggested when 1R plus the spread exceeds it, none = no trade); time stop 21:30. Alerts: stop, TP1, TP2, cap, time stop. The gauge shows the open result in R. Dark theme tokens from `../DESIGN_SYSTEM.md`.

Not in the prototype: gas, USIB, the Research desk, the settings screen, a real chain, sounds beyond simple tones.
