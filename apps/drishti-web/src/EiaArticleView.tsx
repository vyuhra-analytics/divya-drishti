import { useEffect, useState } from "react";
import type { Article, ArticleCheck, EiaReportCode } from "@drishti/shared";
import { apiUrl, useClock } from "./settings";

interface Version {
  article: Article;
  /** the check of every paragraph against the facts; the Claude version carries the one made when it was submitted */
  check: ArticleCheck | null;
  markdown: string;
  at?: number;
}

interface Loaded {
  weekEnding: string;
  template: { article: Article; check: ArticleCheck; markdown: string };
  written: { article: Article; grounding: ArticleCheck | null; markdown: string; at: number } | null;
}

const MARK = { verified: "✓", unverified: "?", wrong: "✗" } as const;
const TIP = {
  verified: "Every figure here was checked against the report's data",
  unverified: "Nothing contradicts it, but it could not be fully checked",
  wrong: "A cited figure contradicts the data",
} as const;

/**
 * The release article for the report shown: the one the app writes from its own rules, and, once Claude has written one over MCP, that one beside it.
 * Each paragraph carries the result of the check of its figures against the data (a tick, a question mark, a cross). Export as markdown.
 */
export function EiaArticleView({ report, week, forecast, active }: { report: EiaReportCode; /** a stored week to write about; leave out for the newest */ week?: string; forecast?: number; active: boolean }) {
  const clock = useClock();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [which, setWhich] = useState<"rules" | "claude">("rules");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    const load = () => {
      const q = new URLSearchParams({ report });
      if (week) q.set("week", week);
      if (forecast !== undefined) q.set("forecast", String(forecast));
      fetch(`${apiUrl()}/eia-report/article?${q}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (res.status === 404) {
            setData(null);
            setError("No stored report yet, so no article. It is written from the report the moment it is stored.");
            return;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setData(await res.json());
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [report, week, forecast, active]);

  if (!active) return null;
  if (!data) return <p className="empty muted">{error ?? "Writing the article…"}</p>;

  const claude = data.written;
  const shown: Version = which === "claude" && claude ? { article: claude.article, check: claude.grounding, markdown: claude.markdown, at: claude.at } : { article: data.template.article, check: data.template.check, markdown: data.template.markdown };
  const verdicts = new Map((shown.check?.paragraphs ?? []).map((p) => [`${p.section}:${p.index}`, p]));
  const file = `eia-${report.toLowerCase()}-${data.weekEnding}${which === "claude" && claude ? "-claude" : ""}.md`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the clipboard is not available: the download still works */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([shown.markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="er-article">
      <div className="toolbar no-drag" role="group" aria-label="Article version">
        <button className={which === "rules" ? "tf active" : "tf"} onClick={() => setWhich("rules")} title="Written by the app's own rules from the report's tables">
          App
        </button>
        <button className={which === "claude" ? "tf active" : "tf"} disabled={!claude} onClick={() => setWhich("claude")} title={claude ? `Written by Claude over MCP, ${clock.stamp(claude.at)}` : "No article from Claude yet: ask Claude to write one with the get_eia_release_context and submit_eia_article tools"}>
          Claude{claude ? "" : " (none yet)"}
        </button>
        {shown.check && (
          <span className={shown.check.wrong ? "down" : "muted"} title="Each paragraph's figures are compared with the report's data by code">
            {shown.check.verified} of {shown.check.total} paragraphs checked{shown.check.wrong ? `, ${shown.check.wrong} contradict the data` : ""}
          </span>
        )}
        <button className="tf" onClick={copy}>
          {copied ? "Copied" : "Copy markdown"}
        </button>
        <button className="tf" onClick={download}>
          Download .md
        </button>
      </div>
      <div className="er-body" tabIndex={0} role="region" aria-label="Release article">
        <h2 className="er-art-title">{shown.article.title}</h2>
        <p className="er-dek">{shown.article.dek}</p>
        {shown.article.sections.map((s, si) => (
          <section key={si}>
            <h3>{s.heading}</h3>
            {s.paragraphs.map((p, pi) => {
              const v = verdicts.get(`${si}:${pi}`);
              return (
                <p key={pi} className="er-para">
                  {v && (
                    <i className={`er-check ${v.verdict}`} title={v.issues.length ? `${TIP[v.verdict]}: ${v.issues.map((x) => x.text).join(" ")}` : TIP[v.verdict]}>
                      {MARK[v.verdict]}
                    </i>
                  )}
                  {p.text}
                </p>
              );
            })}
          </section>
        ))}
        <p className="muted er-art-foot">
          {which === "claude" ? "Written by Claude from the app's facts; each figure checked by code." : "Written by the app's own rules from EIA's tables, history and the recorded market."} Research summary, not advice.
        </p>
      </div>
    </div>
  );
}
