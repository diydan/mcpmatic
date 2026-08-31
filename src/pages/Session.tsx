import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { AuditRow, ServerMessage, ToolSchema } from "../../shared/protocol";

import { ChatPanel } from "../components/ChatPanel";
import { Viewport } from "../components/Viewport";
import { Consent } from "../components/Consent";
import { BlessGate } from "../components/BlessGate";
import { ThemeToggle } from "../components/ThemeToggle";
import { openBridge } from "../lib/bridge";
import { registerAll, type BlessRequest } from "../lib/register-all";
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
      text: "Grant an origin. Shopify stores proxy their native WebMCP. Kayak is synthesised. This panel only calls getTools / executeTool.",
    },
  ]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [jpeg, setJpeg] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [browser, setBrowser] = useState<"live" | "missing">("missing");
  const [busy, setBusy] = useState(false);
  const [consented, setConsented] = useState<Set<string>>(new Set());
  const [bless, setBless] = useState<BlessRequest | null>(null);
  const blessWait = useRef<((ok: boolean) => void) | null>(null);
  const bridgeRef = useRef<ReturnType<typeof openBridge> | null>(null);
  const registration = useRef<AbortController | null>(null);

  const refreshTools = useCallback(async () => {
    const mc = ensureModelContext();
    const list = await mc.getTools();
    setTools(list.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })));
  }, []);

  const reregister = useCallback(
    async (granted: ReadonlySet<string>) => {
      registration.current?.abort();
      const exec = (name: string, args: Record<string, unknown>) => {
        const bridge = bridgeRef.current;
        if (!bridge) return Promise.reject(new Error("no bridge"));
        return bridge.exec(name, args);
      };
      registration.current = await registerAll({
        manifests: MANIFESTS,
        consented: granted,
        executeRemote: exec,
        resolveFields: (paths) => profileStore.resolve(paths),
        bless: (req) =>
          new Promise((resolve) => {
            blessWait.current = resolve;
            setBless(req);
          }),
      });
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
            const listed = await mc.getTools();
            const tool = listed.find((t) => t.name === msg.name);
            if (!tool) {
              setLines((l) => [
                ...l,
                { kind: "system", text: `tool ${msg.name} is not registered` },
              ]);
              return;
            }
            await mc.executeTool(tool, msg.arguments);
          })();
        }
      },
    });
    bridgeRef.current = bridge;
    void reregister(new Set());
    bridge.send({ v: 1, type: "screencast", on: true });

    return () => {
      mc.removeEventListener("toolchange", onChange);
      registration.current?.abort();
      bridge.close();
    };
  }, [sessionToken, reregister, refreshTools]);

  const grant = async (origin: string) => {
    const res = await fetch(`/s/${sessionToken}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin }),
    });
    if (!res.ok) return;
    const next = new Set(consented);
    next.add(origin);
    setConsented(next);
    await reregister(next);
    setLines((l) => [
      ...l,
      { kind: "system", text: `granted ${origin}` },
    ]);
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
