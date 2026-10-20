import { useState } from "react";
import { SYMBOLS } from "@drishti/shared";
import { MNEMONICS, parse, type Command } from "./command";
import { useWorkspace } from "./workspace";

function run(cmd: Command) {
  const { widgets, focusedId, addWidget, loadSymbol } = useWorkspace.getState();
  const focused = widgets.find((w) => w.id === focusedId) ?? widgets[0];
  if (cmd.open) addWidget(cmd.open, cmd.symbol);
  else if (cmd.symbol && focused) loadSymbol(focused.id, cmd.symbol);
}

export function Palette() {
  const setOpen = useWorkspace((s) => s.setPaletteOpen);
  const [input, setInput] = useState("");
  const [sel, setSel] = useState(0);
  const result = parse(input, SYMBOLS);
  const suggestions = result.ok ? [] : result.suggestions.slice(0, 8);

  const close = () => setOpen(false);
  const submit = () => {
    if (result.ok) {
      run(result.cmd);
      return close();
    }
    const pick = suggestions[sel];
    if (!pick) return;
    // replace the bad token with the highlighted suggestion and run
    const tokens = input.trim().split(/\s+/);
    const bad = result.error.match(/"(.*)"/)?.[1];
    const fixed = bad ? tokens.map((t) => (t.toUpperCase() === bad ? pick : t)).join(" ") : pick;
    const retry = parse(fixed, SYMBOLS);
    if (retry.ok) {
      run(retry.cmd);
      close();
    } else setInput(fixed);
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Command" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={input}
          placeholder="TCS · TCS GP · GP · Q · W"
          aria-label="Command"
          onChange={(e) => {
            setInput(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "Enter") submit();
            else if (e.key === "ArrowDown") setSel((i) => Math.min(i + 1, suggestions.length - 1));
            else if (e.key === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
            else return;
            e.preventDefault();
          }}
        />
        {result.ok ? (
          <div className="palette-hint">
            ↵ {result.cmd.open ? `open ${result.cmd.open}` : "load"} {result.cmd.symbol ?? "focused symbol"}
          </div>
        ) : (
          <>
            {input && <div className="palette-hint down">{result.error}</div>}
            <ul>
              {suggestions.map((s, i) => (
                <li key={s} className={i === sel ? "active" : ""} onMouseEnter={() => setSel(i)} onClick={submit}>
                  {s}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="palette-hint muted">
          {Object.entries(MNEMONICS)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        </div>
      </div>
    </div>
  );
}
