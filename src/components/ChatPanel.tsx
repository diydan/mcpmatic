import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { AuditRow, ToolSchema } from "../../shared/protocol";
import { RICH_SCHEMA } from "../lib/chat-sanitize-schema";

type Line =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string }
  | { kind: "tool"; text: string };

type Props = {
  tools: ToolSchema[];
  audit: AuditRow[];
  lines: Line[];
  busy: boolean;
  onSend: (text: string) => void;
};

export function ChatPanel({ tools, audit, lines, busy, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  return (
    <section className="chat" aria-label="Agent">
      <ul className="chat__tools">
        {tools.length === 0 ? (
          <li className="muted">no tools registered — check the log</li>
        ) : (
          tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
            </li>
          ))
        )}
      </ul>
      <div className="chat__log" ref={scroller} role="log">
        {lines.map((line, i) => {
          // Assistant and tool lines come from uncontrolled sources
          // (LLM output via WebSocket, JSON-shaped tool results), so we
          // render them as Markdown. User and system lines are short
          // status text by author — Markdown there would be pure noise.
          // rehype-sanitize strips any HTML that would survive the
          // Markdown parser's own HTML stripping (default `skipHtml:
          // true` in react-markdown v10), so XSS in LLM output can't
          // reach the DOM.
          //
          // User/system lines stay as `<p>` (clean semantic and matches
          // the existing .chat__log p[data-kind="..."] CSS). Markdown
          // lines use a `<div>` wrapper because ReactMarkdown emits its
          // own block-level elements and nesting those inside a `<p>`
          // would be invalid HTML; the CSS keys off `[data-kind="..."]`
          // without a tag qualifier so both shapes pick up the styling.
          const rich = line.kind === "assistant" || line.kind === "tool";
          return rich ? (
            <div
              key={i}
              data-kind={line.kind}
              className="chat__line chat__line--rich"
            >
              <ReactMarkdown rehypePlugins={[[rehypeSanitize, RICH_SCHEMA]]}>
                {line.text}
              </ReactMarkdown>
            </div>
          ) : (
            <p key={i} data-kind={line.kind}>
              {line.text}
            </p>
          );
        })}
      </div>
      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text || busy) return;
          onSend(text);
          setDraft("");
        }}
      >
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask the agent to use a tool…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
      <aside className="chat__audit" aria-label="Audit trail">
        <h2>audit</h2>
        <p className="muted">names only — no values, no keystrokes</p>
        <ul>
          {audit.map((row, i) => (
            <li key={`${row.timestamp}-${i}`}>
              <code>{row.tool}</code>
              <span>{row.origin.replace(/^https:\/\//, "")}</span>
              {row.fieldNames.length ? (
                <span>{row.fieldNames.join(", ")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
