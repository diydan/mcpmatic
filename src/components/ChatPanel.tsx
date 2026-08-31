import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { AuditRow, ToolSchema } from "../../shared/protocol";

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
  headerRight?: ReactNode;
  onSend: (text: string) => void;
};

export function ChatPanel({ tools, audit, lines, busy, headerRight, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  return (
    <section className="chat" aria-label="Agent">
      <header className="chat__bar">
        <div>
          <h1>mcpmatic</h1>
          <p>getTools / executeTool · native Shopify when present</p>
        </div>
        {headerRight}
      </header>
      <ul className="chat__tools">
        {tools.length === 0 ? (
          <li className="muted">no tools until you grant an origin</li>
        ) : (
          tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
            </li>
          ))
        )}
      </ul>
      <div className="chat__log" ref={scroller} role="log">
        {lines.map((line, i) => (
          <p key={i} data-kind={line.kind}>
            {line.text}
          </p>
        ))}
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
