import { SYMBOLS, TIMEFRAMES, type Timeframe } from "@drishti/shared";
import { Chart } from "./Chart";
import { useStore } from "./store";

function Price({ symbol }: { symbol: string }) {
  const tick = useStore((s) => s.quotes[symbol]);
  const prev = useStore((s) => s.prev[symbol]);
  if (!tick) return <span className="muted">—</span>;
  const dir = tick.price > prev ? "up" : tick.price < prev ? "down" : "";
  return <span className={dir}>{tick.price.toFixed(2)}</span>;
}

export function App() {
  const status = useStore((s) => s.status);
  const active = useStore((s) => s.active);
  const tf = useStore((s) => s.tf);
  const setActive = useStore((s) => s.setActive);
  const setTf = useStore((s) => s.setTf);

  return (
    <div className="shell">
      <header>
        <strong className="brand">DIVYA DRISHTI</strong>
        <div className="ticker">
          {SYMBOLS.map((s) => (
            <span key={s}>
              {s} <Price symbol={s} />
            </span>
          ))}
        </div>
        <span className={`status ${status}`}>● {status}</span>
      </header>
      <aside>
        {SYMBOLS.map((s) => (
          <button key={s} className={s === active ? "row active" : "row"} onClick={() => setActive(s)}>
            <span>{s}</span>
            <Price symbol={s} />
          </button>
        ))}
      </aside>
      <main>
        <div className="toolbar">
          <strong>{active}</strong>
          {(Object.keys(TIMEFRAMES) as Timeframe[]).map((t) => (
            <button key={t} className={t === tf ? "tf active" : "tf"} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </div>
        <Chart symbol={active} tf={tf} />
      </main>
    </div>
  );
}
