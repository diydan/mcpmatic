import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type {
  AuditRow,
  BrowserState,
  ServerMessage,
  ToolSchema,
} from "../../shared/protocol";

import { ChatPanel } from "../components/ChatPanel";
import { Viewport } from "../components/Viewport";
import { Consent } from "../components/Consent";
import { BlessGate } from "../components/BlessGate";
import { ThemeToggle } from "../components/ThemeToggle";
import { openBridge } from "../lib/bridge";
import {
  createRegistration,
  type BlessRequest,
  type Registration,
} from "../lib/register-all";
import { profileStore, seedIfEmpty } from "../lib/profile-store";
import { ensureModelContext } from "../lib/webmcp-polyfill";
import { allManifests, STORES } from "../../shared/stores";

const MANIFESTS = allManifests();
const ORIGINS = STORES.map((s) => ({
  origin: s.origin,
  label: s.label,
  kind: s.kind,
}));

type Line = {
  kind: "user" | "assistant" | "system" | "tool";
  text: string;
};

export function Session() {
  const { sessionToken = "" } = useParams();
  const [tools, setTools] = useState<ToolSchema[]>([]);
  const [lines, setLines] = useState<Line[]>([
    {
      kind: "system",
      text: "get_page_state, list_available_origins and navigate_to are always registered. Grant an origin to add its tools. Shopify stores proxy their native WebMCP; Kayak is synthesised. This panel only calls getTools / executeTool.",
    },
  ]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [jpeg, setJpeg] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [browser, setBrowser] = useState<BrowserState>("missing");
  const [busy, setBusy] = useState(false);
  const [consented, setConsented] = useState<Set<string>>(new Set());
  const [bless, setBless] = useState<BlessRequest | null>(null);
  const blessWait = useRef<((ok: boolean) => void) | null>(null);
  const bridgeRef = useRef<ReturnType<typeof openBridge> | null>(null);
  const registrationRef = useRef<Registration | null>(null);

  const refreshTools = useCallback(async () => {
    const mc = ensureModelContext();
    const list = await mc.getTools();
    setTools(list.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })));
  }, []);

  const syncTools = useCallback(
    async (registration: Registration, granted: ReadonlySet<string>) => {
      const report = await registration.sync(granted);
      for (const failure of report.failed) {
        setLines((l) => [
          ...l,
          {
            kind: "system",
            text: `could not register ${failure.name}: ${failure.message}`,
          },
        ]);
      }
      await refreshTools();
    },
    [refreshTools],
  );

  useEffect(() => {
    seedIfEmpty();
    const mc = ensureModelContext();
    const onChange = () => void refreshTools();
    mc.addEventListener("toolchange", onChange);

    const bridge = openBridge(sessionToken, {
      onClose: () => {
        setBusy(false);
        setLines((l) => [
          ...l,
          {
            kind: "system",
            text: "bridge closed — the session expired, or another tab took it over. Reload to reconnect.",
          },
        ]);
      },
      onMessage: (msg: ServerMessage) => {
        if (msg.type === "frame") setJpeg(msg.jpeg);
        if (msg.type === "state") {
          setDriving(msg.driving);
          setBrowser(msg.browser);
        }
        if (msg.type === "audit") setAudit(msg.rows);
        if (msg.type === "assistant") {
          setLines((l) => [...l, { kind: "assistant", text: msg.content }]);
          setBusy(false);
        }
        if (msg.type === "error") {
          setLines((l) => [...l, { kind: "system", text: msg.message }]);
          setBusy(false);
        }
        if (msg.type === "tool_call") {
          setLines((l) => [
            ...l,
            { kind: "tool", text: `executeTool ${msg.name}` },
          ]);
          void (async () => {
            // Whatever happens below, the DO gets exactly one tool_result for
            // this call id. Otherwise the agent turn strands and the chat box
            // stays disabled for the rest of the session.
            let ok = true;
            let result = "";
            try {
              const listed = await mc.getTools();
              const tool = listed.find((t) => t.name === msg.name);
              if (!tool) {
                ok = false;
                result = `tool ${msg.name} is not registered on this page`;
                setLines((l) => [...l, { kind: "system", text: result }]);
              } else {
                result = await mc.executeTool(tool, msg.arguments);
              }
            } catch (err) {
              ok = false;
              result = err instanceof Error ? err.message : "executeTool failed";
              setLines((l) => [...l, { kind: "system", text: result }]);
            }
            bridgeRef.current?.send({
              v: 1,
              type: "tool_result",
              callId: msg.id,
              ok,
              result,
            });
          })();
        }
      },
    });
    bridgeRef.current = bridge;

    // Created synchronously so the cleanup below can always abort it, even if
    // the first sync is still in flight (React StrictMode remounts).
    const registration = createRegistration({
      manifests: MANIFESTS,
      consented: new Set(),
      executeRemote: (name, args) => {
        const live = bridgeRef.current;
        if (!live) return Promise.reject(new Error("no bridge"));
        return live.exec(name, args);
      },
      resolveFields: (paths) => profileStore.resolve(paths),
      bless: (req) =>
        new Promise((resolve) => {
          blessWait.current = resolve;
          setBless(req);
        }),
    });
    registrationRef.current = registration;
    void syncTools(registration, new Set());
    bridge.send({ v: 1, type: "screencast", on: true });

    const onVisibility = () => {
      bridgeRef.current?.send({
        v: 1,
        type: "screencast",
        on: !document.hidden,
      });
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      mc.removeEventListener("toolchange", onChange);
      registration.abort();
      registrationRef.current = null;
      bridge.close();
    };
  }, [sessionToken, refreshTools, syncTools]);

  const grant = async (origin: string) => {
    const res = await fetch(`/s/${sessionToken}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin }),
    });
    if (!res.ok) {
      setLines((l) => [
        ...l,
        { kind: "system", text: `consent failed for ${origin} (${res.status})` },
      ]);
      return;
    }
    const next = new Set(consented);
    next.add(origin);
    setConsented(next);
    const registration = registrationRef.current;
    // Only this origin's tools are added. Everything already registered keeps
    // its own AbortController and is left alone (SPEC 2.5).
    if (registration) await syncTools(registration, next);
    setLines((l) => [...l, { kind: "system", text: `granted ${origin}` }]);

    // A site we have no manifest for gains no tools of its own, so granting it
    // would look like nothing happened. Send the remote browser there — through
    // the registered tool, not around it, so the invocation path stays
    // getTools/executeTool even when a human started it.
    if (MANIFESTS.some((m) => m.origin === origin)) return;
    try {
      const mc = ensureModelContext();
      const listed = await mc.getTools();
      const nav = listed.find((t) => t.name === "navigate_to");
      if (nav) await mc.executeTool(nav, { origin });
      // Then say what the site brings of its own. For an origin we hold no
      // manifest for this is the only honest answer to "what can it do?", and
      // for a WebMCP site it is the whole point.
      const discover = listed.find((t) => t.name === "list_remote_tools");
      if (discover) {
        const found = await mc.executeTool(discover, {});
        setLines((l) => [...l, { kind: "tool", text: String(found) }]);
      }
    } catch (err) {
      setLines((l) => [
        ...l,
        {
          kind: "system",
          text: err instanceof Error ? err.message : "navigate failed",
        },
      ]);
    }
  };

  return (
    <div className="shell">
      <ChatPanel
        tools={tools}
        audit={audit}
        lines={lines}
        busy={busy}
        headerRight={<ThemeToggle />}
        onSend={(text) => {
          setBusy(true);
          setLines((l) => [...l, { kind: "user", text }]);
          void ensureModelContext()
            .getTools()
            .then((listed) => {
              bridgeRef.current?.send({
                v: 1,
                type: "chat",
                content: text,
                tools: listed.map(({ name, description, inputSchema }) => ({
                  name,
                  description,
                  inputSchema,
                })),
              });
            });
        }}
      />
      <div className="shell__right">
        <Consent origins={ORIGINS} consented={consented} onGrant={(o) => void grant(o)} />
        <Viewport
          jpeg={jpeg}
          driving={driving}
          browser={browser}
          onInput={(evt) => {
            if (evt.kind === "mouse") {
              bridgeRef.current?.send({
                v: 1,
                type: "input",
                kind: "mouse",
                action: evt.action as "moved" | "pressed" | "released" | "wheel",
                x: evt.x ?? 0,
                y: evt.y ?? 0,
                button: evt.button,
                deltaX: evt.deltaX,
                deltaY: evt.deltaY,
              });
              return;
            }
            bridgeRef.current?.send({
              v: 1,
              type: "input",
              kind: "key",
              action: evt.action as "down" | "up" | "insert",
              key: evt.key,
              text: evt.text,
            });
          }}
        />
      </div>
      <BlessGate
        request={bless}
        onDecide={(ok) => {
          blessWait.current?.(ok);
          blessWait.current = null;
          setBless(null);
        }}
      />
    </div>
  );
}
