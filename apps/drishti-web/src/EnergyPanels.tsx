import { useState } from "react";
import { UNIVERSE_GROUPS, type UniverseGroup } from "@drishti/shared";
import { useUniverse, type UniverseView } from "./universe";
import { makeFormat, useSettings } from "./settings";
import { useWorkspace, type Widget } from "./workspace";

const pctText = (p?: number) => (p === undefined ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(2)}%`);
const delayText = (s: number) => (s > 0 ? `${Math.round(s / 60)}m delay` : "live");

/** Prices have no one precision across INR crude and USD gas: show 2 dp under 100, 0–1 above. */
const priceText = (locale: string, v?: number) => {
  if (v === undefined) return "—";
  return makeFormat(locale, v >= 1000 ? 0 : v >= 100 ? 1 : v >= 10 ? 2 : 3).price(v);
};

/** Selecting one of our six instruments loads it into the focused link group; others have no chart, so no click. */
function useOpen() {
  return (row: UniverseView) => {
    if (!row.symbol) return;
    const { widgets, focusedId, loadSymbol } = useWorkspace.getState();
    const target = widgets.find((w) => w.id === focusedId) ?? widgets[0];
    if (target) loadSymbol(target.id, row.symbol);
  };
}

type SortKey = "name" | "price" | "changePct" | "volume" | "range52";
const range52 = (r: UniverseView) =>
  r.price !== undefined && r.high52 !== undefined && r.low52 !== undefined && r.high52 > r.low52 ? (r.price - r.low52) / (r.high52 - r.low52) : undefined;
const sortValue = (r: UniverseView, k: SortKey) => (k === "name" ? r.name.toLowerCase() : k === "range52" ? range52(r) : r[k]);

/** Energy screener: sortable table of the whole universe, filtered by group. */
export function ScreenerWidget(_: { widget: Widget }) {
  const rows = useUniverse();
  const open = useOpen();
  const locale = useSettings((s) => s.locale);
  const [group, setGroup] = useState<UniverseGroup | "All">("All");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "changePct", dir: -1 });
  const shown = rows
    .filter((r) => group === "All" || r.group === group)
    .sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      if (x === undefined) return 1; // missing values always last
      if (y === undefined) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : key === "name" ? 1 : -1 })}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  return (
    <div className="screener">
      <div className="toolbar no-drag">
        {(["All", ...UNIVERSE_GROUPS] as const).map((g) => (
          <button key={g} className={g === group ? "tf active" : "tf"} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
        <span className="news-count muted">{shown.length}</span>
      </div>
      <div className="screener-scroll" tabIndex={0} role="region" aria-label="Screener table">
        <table>
          <thead>
            <tr>
              {head("name", "Name")}
              {head("price", "Last")}
              {head("changePct", "Chg %")}
              {head("volume", "Volume")}
              {head("range52", "52w range")}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const pos = range52(r);
              return (
                <tr key={r.tv} className={r.symbol ? "ours" : undefined} onClick={() => open(r)}>
                  <td title={`${r.tv} · ${delayText(r.delayedBy)}`}>
                    {r.name}
                    <small className="muted"> {r.currency}</small>
                  </td>
                  <td>{priceText(locale, r.price)}</td>
                  <td className={r.changePct === undefined ? "" : r.changePct >= 0 ? "up" : "down"}>{pctText(r.changePct)}</td>
                  <td>{r.volume === undefined ? "—" : makeFormat(locale, 0).volume(r.volume)}</td>
                  <td>
                    {pos === undefined ? (
                      "—"
                    ) : (
                      <span className="range52" title={`${priceText(locale, r.low52)} – ${priceText(locale, r.high52)}`}>
                        <span style={{ left: `${Math.round(pos * 100)}%` }} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
