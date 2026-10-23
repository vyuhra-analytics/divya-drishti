import { useCallback, useEffect, useRef, useState } from "react";
import { LABELS, type Label } from "@drishti/shared";
import { apiUrl } from "./settings";
import type { Widget } from "./workspace";

const LABELER = "owner";
const KEYS: Record<string, Label> = { "1": "bullish", "2": "bearish", "3": "neutral", "4": "not_crude" };
const TITLE: Record<Label, string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral", not_crude: "Not crude" };
const HELP: Record<Label, string> = {
  bullish: "implies higher crude prices",
  bearish: "implies lower crude prices",
  neutral: "about crude, no clear direction",
  not_crude: "not about the crude price",
};

interface Item {
  id: number;
  title: string;
  outlet: string;
}
interface Next {
  item: Item | null;
  total: number;
  done: number;
}

/** Label a headline by what it implies for the price of crude: 1 bullish, 2 bearish, 3 neutral, 4 not crude, M flags a price move already reported, U takes the last one back, S skips. */
export function LabelWidget(_: { widget: Widget }) {
  const [state, setState] = useState<Next | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [afterMove, setAfterMove] = useState(false);
  const [session, setSession] = useState(0);
  const skipped = useRef<number[]>([]);
  const busy = useRef(false);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ labeler: LABELER, skip: skipped.current.join(",") });
      const res = await fetch(`${apiUrl()}/labels/next?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const submit = useCallback(
    async (label: Label) => {
      const item = state?.item;
      if (!item || busy.current) return;
      busy.current = true;
      try {
        const res = await fetch(`${apiUrl()}/labels`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sampleId: item.id, labeler: LABELER, label, afterMove }) });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${res.status}`);
        setAfterMove(false);
        setSession((n) => n + 1);
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        busy.current = false;
      }
    },
    [state, afterMove, load],
  );

  const undo = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`${apiUrl()}/labels/last?labeler=${LABELER}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${res.status}`);
      skipped.current = [];
      setSession((n) => Math.max(0, n - 1));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [load]);

  const skip = useCallback(() => {
    if (state?.item) skipped.current.push(state.item.id);
    void load();
  }, [state, load]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (KEYS[k]) void submit(KEYS[k]);
    else if (k === "m") setAfterMove((v) => !v);
    else if (k === "u") void undo();
    else if (k === "s") skip();
    else return;
    e.preventDefault();
  };

  if (!state) return <p className="empty muted">{error ? `Labelling unavailable: ${error}` : "Loading…"}</p>;
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  return (
    <div className="labeller" tabIndex={0} onKeyDown={onKey} role="region" aria-label="Label headlines (keys 1 to 4, M, U, S)">
      <div className="lb-progress" title={`${state.done} of ${state.total} labeled; ${session} this session`}>
        <i style={{ width: `${pct}%` }} />
        <span>
          {state.done} / {state.total} labeled · {session} this session
        </span>
      </div>
      {state.item ? (
        <>
          <p className="lb-title">{state.item.title}</p>
          <p className="muted lb-outlet">{state.item.outlet}</p>
          <div className="lb-buttons" role="group" aria-label="Label">
            {LABELS.map((l, i) => (
              <button key={l} className={`lb-${l}`} onClick={() => void submit(l)} title={HELP[l]}>
                <kbd>{i + 1}</kbd> {TITLE[l]}
                <small>{HELP[l]}</small>
              </button>
            ))}
          </div>
          <label className="lb-move">
            <input type="checkbox" checked={afterMove} onChange={(e) => setAfterMove(e.target.checked)} /> <kbd>M</kbd> only reports a price move that already happened
          </label>
          <div className="lb-extra">
            <button onClick={() => void undo()}>
              <kbd>U</kbd> Take the last one back
            </button>
            <button onClick={skip}>
              <kbd>S</kbd> Skip
            </button>
          </div>
          <p className="muted lb-rule">
            Label what the headline implies for the PRICE of crude, not its tone: "tankers attacked" is bullish. If you remember what the price did, ignore it. Unsure between a direction and neutral: neutral.
          </p>
        </>
      ) : (
        <p className="empty muted">{state.total === 0 ? "No headlines sampled yet: run bun run gold:sample -- --source=news." : "Every headline in the sample is labeled. Thank you."}</p>
      )}
      {error && <p className="down">{error}</p>}
    </div>
  );
}
