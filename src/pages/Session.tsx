import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import type {
  AuditRow,
  BrowserState,
  DiscoveredTool,
  ServerMessage,
  ToolSchema,
} from "../../shared/protocol";

import { ChatPanel } from "../components/ChatPanel";
import { Viewport } from "../components/Viewport";
import { Consent } from "../components/Consent";
import { BlessGate } from "../components/BlessGate";
import { ManifestReview, type ManifestDraft } from "../components/ManifestReview";
import { ThemeToggle } from "../components/ThemeToggle";
import { Header } from "../components/Header";
import { openBridge } from "../lib/bridge";
import {
  createRegistration,
  type BlessRequest,
  type ObservedByOrigin,
  type Registration,
} from "../lib/register-all";
import { Surface } from "../components/Surface";
import { profileStore, seedIfEmpty } from "../lib/profile-store";
import { answerApproval } from "../lib/approval-reply";
import { accountId } from "../lib/account-store";
import { PasskeyBar } from "../components/PasskeyBar";
import { unionOrigins } from "../../shared/origin";
import { ensureModelContext } from "../lib/webmcp-polyfill";
import { allManifests, STORES } from "../../shared/stores";
import { navigationHref, normaliseOrigin } from "../../shared/origin";

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

function originFromNavState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const origin = (state as { origin?: unknown }).origin;
  return typeof origin === "string" && origin ? origin : null;
}

type SessionRole = "console" | "facade";

/**
 * `console` is the human at `/c/<token>`: it holds the profile and answers
 * approvals. `facade` is `/s/<token>`, loaded by an agent — it registers tools
 * and is never asked to release a field on the human's behalf.
 */
export function Session({ role = "facade" }: { role?: SessionRole }) {
  const isConsole = role === "console";
  const { sessionToken = "" } = useParams();
  const seededFromNav = originFromNavState(useLocation().state);
  const [tools, setTools] = useState<ToolSchema[]>([]);
  const [lines, setLines] = useState<Line[]>([
    {
      kind: "system",
      text: "You browse; ChatGPT calls tools on this page. Grant an origin to add its tools. Shopify stores proxy their native WebMCP; Kayak and GOV.UK are synthesised. Observed tools from the open page are registered origin-qualified.",
    },
  ]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [jpeg, setJpeg] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [browser, setBrowser] = useState<BrowserState>("missing");
  const [busy, setBusy] = useState(false);
  const [navBusy, setNavBusy] = useState(false);
  const [navError, setNavError] = useState<string | undefined>(undefined);
  const [consented, setConsented] = useState<Set<string>>(
    () => new Set(seededFromNav ? [seededFromNav] : []),
  );
  const [pageOrigin, setPageOrigin] = useState<string | null>(seededFromNav);
  const [pageUrl, setPageUrl] = useState<string | null>(seededFromNav);
  const [remoteTools, setRemoteTools] = useState<DiscoveredTool[]>([]);
  const [autonomous, setAutonomous] = useState(false);
  const [bless, setBless] = useState<BlessRequest | null>(null);
  const [manifestDraft, setManifestDraft] = useState<ManifestDraft | null>(null);
  const [mapSiteBusy, setMapSiteBusy] = useState(false);
  const blessWait = useRef<((ok: boolean) => void) | null>(null);
  /**
   * One dialog at a time. A second request arriving while one is open is
   * denied rather than replacing it — replacing would strand whoever is
   * waiting on the first, and there is only one human here to answer anyway.
   */
  /** Close a dialog the server has stopped waiting on, freeing the slot. */
  const dismissBless = useCallback(() => {
    blessWait.current = null;
    setBless(null);
  }, []);
  const askBless = useCallback(
    (req: BlessRequest) =>
      new Promise<boolean>((resolve) => {
        if (blessWait.current) {
          resolve(false);
          return;
        }
        blessWait.current = resolve;
        setBless(req);
      }),
    [],
  );
  const bridgeRef = useRef<ReturnType<typeof openBridge> | null>(null);
  const registrationRef = useRef<Registration | null>(null);
  const consentedRef = useRef(consented);
  const browserRef = useRef(browser);
  const observedRef = useRef<Record<string, DiscoveredTool[]>>({});
  const observedKeyRef = useRef("");
  consentedRef.current = consented;
  browserRef.current = browser;

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
    async (
      registration: Registration,
      granted: ReadonlySet<string>,
      observed?: ObservedByOrigin,
    ) => {
      const report = await registration.sync(granted, observed);
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

  // Hydrate any pre-seeded consent (origin passed to POST /sessions) on
  // mount. Without this, the Consent panel would show nothing granted
  // and the WebMCP registration was created with an empty consented set,
  // so tools for the seeded origin wouldn't appear until the user
  // manually re-grants. Runs after the main setup effect so
  // registrationRef is populated; the brief window between mount and
  // fetch is harmless because the user can't trigger a tool call that
  // fast.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let seeded: string[] = [];
      // Claim the session for this browser's account first, so the grants it
      // already carries come back before we read consent. A session that was
      // never claimed, or a browser with no storage, simply skips this and
      // behaves exactly as it did before accounts existed.
      if (isConsole) {
        const id = accountId();
        if (id) {
          try {
            const res = await fetch(`/s/${sessionToken}/account`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ accountId: id }),
            });
            if (res.ok) {
              const body = (await res.json()) as { consent?: unknown };
              if (Array.isArray(body.consent)) {
                seeded = body.consent.filter(
                  (x): x is string => typeof x === "string",
                );
              }
            }
          } catch {
            /* no account this load; the session still works */
          }
        }
      }
      try {
        const res = await fetch(`/s/${sessionToken}/consent`);
        if (res.ok) {
          const body = (await res.json()) as {
            consent?: unknown;
            autonomous?: unknown;
          };
          if (body.autonomous === true) setAutonomous(true);
          if (Array.isArray(body.consent)) {
            seeded = unionOrigins(
              seeded,
              body.consent.filter((x): x is string => typeof x === "string"),
            );
          }
        }
      } catch {
        return; // network error: user can grant manually
      }
      if (cancelled || seeded.length === 0) return;
      const next = new Set(seeded);
      setConsented(next);
      setPageOrigin((o) => o ?? seeded[0]);
      setPageUrl((u) => u ?? seeded[0]);
      const reg = registrationRef.current;
      if (reg) await syncTools(reg, next, observedRef.current);
      setLines((l) => [
        ...l,
        {
          kind: "system",
          text: `already granted: ${seeded.join(", ")}`,
        },
      ]);
      // Open the first seeded origin so the viewport is not empty and ChatGPT
      // sees the remote tools as soon as they register.
      try {
        const mc = ensureModelContext();
        const listed = await mc.getTools();
        const nav = listed.find((t) => t.name === "navigate_to");
        if (nav) await mc.executeTool(nav, { origin: seeded[0] });
      } catch {
        /* browser binding missing; tools still register */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionToken, syncTools]);

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
          if (msg.origin) setPageOrigin(msg.origin);
          if (msg.url) setPageUrl(msg.url);
          if (typeof msg.autonomous === "boolean") setAutonomous(msg.autonomous);
          if (msg.consented) {
            const next = new Set(msg.consented);
            const same =
              next.size === consentedRef.current.size &&
              [...next].every((o) => consentedRef.current.has(o));
            if (!same) {
              consentedRef.current = next;
              setConsented(next);
              const reg = registrationRef.current;
              if (reg) {
                void syncTools(reg, next, observedRef.current);
              }
            }
          }
          if (msg.origin && msg.remoteTools) {
            const key = `${msg.origin}:${msg.remoteTools.map((t) => t.name).join(",")}`;
            setRemoteTools(msg.remoteTools);
            if (key !== observedKeyRef.current) {
              observedKeyRef.current = key;
              observedRef.current = {
                ...observedRef.current,
                [msg.origin]: msg.remoteTools,
              };
              const reg = registrationRef.current;
              if (reg) {
                void syncTools(reg, consentedRef.current, observedRef.current);
              }
            }
          }
        }
        if (msg.type === "audit") setAudit(msg.rows);
        if (msg.type === "approval_request" && isConsole) {
          // A tool call is suspended on the DO waiting for this. The profile
          // lives here and nowhere else, so this is the only place that can
          // answer it.
          void answerApproval(msg, {
            bless: askBless,
            resolveFields: (paths) => profileStore.resolve(paths),
            dismiss: dismissBless,
          }).then((reply) => bridgeRef.current?.send(reply));
        }
        if (msg.type === "assistant") {
          setLines((l) => [...l, { kind: "assistant", text: msg.content }]);
          setBusy(false);
        }
        if (msg.type === "error") {
          setLines((l) => [...l, { kind: "system", text: msg.message }]);
          setBusy(false);
          setMapSiteBusy(false);
        }
        if (msg.type === "manifest_draft") {
          setMapSiteBusy(false);
          setManifestDraft(
            msg.tools.length > 0 ? { origin: msg.origin, tools: msg.tools } : null,
          );
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
    }, role);
    bridgeRef.current = bridge;

    // Created synchronously so the cleanup below can always abort it, even if
    // the first sync is still in flight (React StrictMode remounts).
    const registration = createRegistration({
      manifests: MANIFESTS,
      consented: new Set(seededFromNav ? [seededFromNav] : []),
      executeRemote: (name, args) => {
        const live = bridgeRef.current;
        if (!live) return Promise.reject(new Error("no bridge"));
        return live.exec(name, args);
      },
      // The façade holds no profile. A fillsFrom tool still registers there;
      // the DO suspends it and the console supplies the fields.
      resolveFields: isConsole ? (paths) => profileStore.resolve(paths) : undefined,
      bless: isConsole ? askBless : undefined,
    });
    registrationRef.current = registration;
    void syncTools(
      registration,
      new Set(seededFromNav ? [seededFromNav] : []),
    );
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
  }, [sessionToken, refreshTools, syncTools, seededFromNav]);

  const persistConsent = async (origin: string): Promise<boolean> => {
    if (consentedRef.current.has(origin)) return true;
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
      return false;
    }
    const next = new Set(consentedRef.current);
    next.add(origin);
    consentedRef.current = next;
    setConsented(next);
    const registration = registrationRef.current;
    if (registration) await syncTools(registration, next, observedRef.current);
    setLines((l) => [...l, { kind: "system", text: `granted ${origin}` }]);
    return true;
  };

  // Mirror of persistConsent: the server is the source of truth, the local
  // set follows, and the tool registration re-syncs so the origin's tools
  // unregister immediately. The account write happens DO-side via waitUntil.
  const revoke = async (origin: string): Promise<boolean> => {
    const res = await fetch(`/s/${sessionToken}/consent`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin }),
    });
    if (!res.ok) {
      setLines((l) => [
        ...l,
        { kind: "system", text: `revoke failed for ${origin} (${res.status})` },
      ]);
      return false;
    }
    const next = new Set(consentedRef.current);
    next.delete(origin);
    consentedRef.current = next;
    setConsented(next);
    const registration = registrationRef.current;
    if (registration) await syncTools(registration, next, observedRef.current);
    setLines((l) => [...l, { kind: "system", text: `revoked ${origin}` }]);
    return true;
  };

  const openHref = async (raw: string): Promise<boolean> => {
    const href = navigationHref(raw);
    const origin = normaliseOrigin(raw);
    if (!href || !origin) {
      setNavError("Needs an https site, like allbirds.com");
      return false;
    }
    if (!(await persistConsent(origin))) return false;
    await bridgeRef.current?.exec("navigate_to", { origin: href });
    setPageOrigin(origin);
    setPageUrl(href);
    return true;
  };

  const grant = async (origin: string) => {
    if (!(await persistConsent(origin))) return;
    if (browserRef.current !== "live") {
      setPageOrigin(origin);
      setPageUrl(origin);
    }

    // Open the page when nothing is live yet so ChatGPT sees observed tools.
    // If a browser is already on another granted origin, stay — granting
    // Brooklinen must not dump Allbirds from the viewport.
    const shouldOpen =
      browserRef.current !== "live" ||
      !MANIFESTS.some((m) => m.origin === origin);
    if (!shouldOpen) return;
    try {
      await openHref(origin);
      const mc = ensureModelContext();
      const listed = await mc.getTools();
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

  const runOffer = async (name: string) => {
    const mc = ensureModelContext();
    const listed = await mc.getTools();
    const tool = listed.find((t) => t.name === name);
    if (!tool) {
      setLines((l) => [
        ...l,
        { kind: "system", text: `tool ${name} is not registered on this page` },
      ]);
      return;
    }
    setLines((l) => [...l, { kind: "tool", text: `you started ${name}` }]);
    try {
      const result = await mc.executeTool(tool, {});
      setLines((l) => [...l, { kind: "tool", text: String(result) }]);
    } catch (err) {
      setLines((l) => [
        ...l,
        {
          kind: "system",
          text: err instanceof Error ? err.message : "offer failed",
        },
      ]);
    }
  };

  return (
    <div className="shell">
      <div className="shell__top">
        <Header
          placeholder="https://example.com"
          submitLabel="Navigate"
          disabled={navBusy}
          error={navError}
          currentUrl={pageUrl ?? pageOrigin ?? ""}
          onSubmit={async (url) => {
            setNavError(undefined);
            setNavBusy(true);
            try {
              await openHref(url);
            } catch (err) {
              setNavError(
                err instanceof Error ? err.message : "navigation failed",
              );
            } finally {
              setNavBusy(false);
            }
          }}
        />
        <ThemeToggle />
      </div>
      <ChatPanel
        tools={tools}
        audit={audit}
        lines={lines}
        busy={busy}
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
        <Consent
          origins={ORIGINS}
          consented={consented}
          onGrant={(o) => void grant(o)}
          onRevoke={(o) => void revoke(o)}
          autonomous={autonomous}
          onAutonomous={(on) => {
            setAutonomous(on);
            bridgeRef.current?.send({ v: 1, type: "autonomous", on });
            setLines((l) => [
              ...l,
              {
                kind: "system",
                text: on
                  ? "autonomous on — demo origins granted; new sites grant on open"
                  : "autonomous off — new sites need a grant",
              },
            ]);
          }}
        />
        {isConsole ? (
          <PasskeyBar
            sessionToken={sessionToken}
            onSignedIn={(id) => {
              // Adopting a different account means different grants. Re-claim
              // this session under it and take what comes back.
              void (async () => {
                const res = await fetch(`/s/${sessionToken}/account`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ accountId: id }),
                });
                if (!res.ok) return;
                const body = (await res.json()) as { consent?: unknown };
                if (!Array.isArray(body.consent)) return;
                const next = new Set(
                  body.consent.filter((x): x is string => typeof x === "string"),
                );
                setConsented(next);
                const reg = registrationRef.current;
                if (reg) await syncTools(reg, next, observedRef.current);
              })();
            }}
          />
        ) : null}
        <Surface
          origin={pageOrigin}
          remoteTools={remoteTools}
          registered={tools}
          onOffer={(name) => void runOffer(name)}
          mapSiteBusy={mapSiteBusy}
          onMapSite={
            pageOrigin
              ? () => {
                  setMapSiteBusy(true);
                  bridgeRef.current?.send({
                    v: 1,
                    type: "generate_manifest",
                    origin: pageOrigin,
                  });
                }
              : undefined
          }
        />
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
      <ManifestReview
        draft={manifestDraft}
        onDecide={(name, ok) => {
          if (!manifestDraft) return;
          bridgeRef.current?.send({
            v: 1,
            type: "manifest_decision",
            origin: manifestDraft.origin,
            name,
            bless: ok,
          });
        }}
      />
    </div>
  );
}
