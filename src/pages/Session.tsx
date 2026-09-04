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
import { ApprovalDialog } from "../components/ApprovalDialog";
import { ThemeToggle } from "../components/ThemeToggle";
import { Header } from "../components/Header";
import { openBridge } from "../lib/bridge";
import {
  createRegistration,
  type ApprovalRequest,
  type ObservedByOrigin,
  type Registration,
} from "../lib/register-all";
import { Surface } from "../components/Surface";
import { profileStore, seedIfEmpty } from "../lib/profile-store";
import { answerApproval } from "../lib/approval-reply";
import { accountId, claimWithStepUp } from "../lib/account-store";
import { PasskeyBar } from "../components/PasskeyBar";
import { displayHosts, unionOrigins } from "../../shared/origin";
import { ensureModelContext } from "../lib/webmcp-polyfill";
import { allManifests, STORES } from "../../shared/stores";
import { navigationHref, normaliseOrigin } from "../../shared/origin";
import { recordRecentSite } from "../lib/recent-sites";

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

function unwrapNavState(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== "object") return null;
  const raw = state as Record<string, unknown>;
  if (raw.usr && typeof raw.usr === "object") {
    return raw.usr as Record<string, unknown>;
  }
  return raw;
}

function originFromNavState(state: unknown): string | null {
  const unwrapped = unwrapNavState(state);
  if (!unwrapped) return null;
  const origin = unwrapped.origin;
  return typeof origin === "string" && origin ? origin : null;
}

function promptFromNavState(state: unknown): string | null {
  const unwrapped = unwrapNavState(state);
  if (!unwrapped) return null;
  const prompt = unwrapped.initialPrompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
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
  const navState = useLocation().state;
  const seededFromNav = originFromNavState(navState);
  const initialPromptFromNav = promptFromNavState(navState);
  const initialPromptSent = useRef(false);
  const [viewMode, setViewMode] = useState<"normal" | "tech">("normal");
  const [tools, setTools] = useState<ToolSchema[]>([]);
  const [lines, setLines] = useState<Line[]>([
    {
      kind: "system",
      text: "👋 Welcome! I'm your AI browsing assistant. Ask me to compare products, find deals, look up information, or fill forms. Watch what I do in the browser window on your right.",
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
  const [autoGrantNew, setAutoGrantNew] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const approvalWait = useRef<((ok: boolean) => void) | null>(null);
  /**
   * One dialog at a time. A second request arriving while one is open is
   * denied rather than replacing it — replacing would strand whoever is
   * waiting on the first, and there is only one human here to answer anyway.
   */
  /** Close a dialog the server has stopped waiting on, freeing the slot. */
  const dismissApproval = useCallback(() => {
    approvalWait.current = null;
    setApproval(null);
  }, []);
  const askApproval = useCallback(
    (req: ApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        if (approvalWait.current) {
          resolve(false);
          return;
        }
        approvalWait.current = resolve;
        setApproval(req);
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
      let seeded: string[] = seededFromNav ? [seededFromNav] : [];
      // Claim the session for this browser's account first, so the grants it
      // already carries come back before we read consent. A session that was
      // never claimed, or a browser with no storage, simply skips this and
      // behaves exactly as it did before accounts existed.
      //
      // The claim is bound to a fresh WebAuthn assertion over a passkey
      // registered to the account — knowledge of the session URL is not
      // enough on its own. A user without a passkey for this account
      // (typically a fresh console with a generated id) still gets a working
      // session; they just do not inherit grants until they register one.
      if (isConsole) {
        const id = accountId();
        if (id) {
          try {
            const claimed = await claimWithStepUp(sessionToken, id);
            if (claimed.ok) {
              seeded = claimed.consent;
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
            autoGrantNew?: unknown;
          };
          if (body.autonomous === true) setAutonomous(true);
          if (body.autoGrantNew === true) setAutoGrantNew(true);
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
      setLines((l) => [
        ...l,
        {
          kind: "system",
          text: `Connected to ${displayHosts(seeded).join(", ")}`,
        },
      ]);
      // If this is a direct site visit (not a general task prompt), open the
      // seeded origin so the viewport renders the site. If it is a task prompt,
      // let the AI agent drive navigation to relevant sites instead of pre-forcing one.
      if (!initialPromptFromNav && seeded[0]) {
        try {
          recordRecentSite(seeded[0]);
          const mc = ensureModelContext();
          const listed = await mc.getTools();
          const nav = listed.find((t) => t.name === "navigate_to");
          if (nav) await mc.executeTool(nav, { origin: seeded[0] });
        } catch {
          /* browser binding missing; tools still register */
        }
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

    let bridgeOpen = false;
    let initialSyncDone = false;

    const maybeDispatchInitialPrompt = async () => {
      if (!initialPromptFromNav || initialPromptSent.current) return;
      if (!bridgeOpen || !initialSyncDone) return;
      initialPromptSent.current = true;
      setBusy(true);
      setLines((l) => [...l, { kind: "user", text: initialPromptFromNav }]);
      const mc = ensureModelContext();
      const listed = await mc.getTools();
      bridgeRef.current?.send({
        v: 1,
        type: "chat",
        content: initialPromptFromNav,
        tools: listed.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    };

    const bridge = openBridge(
      sessionToken,
      {
        onOpen: () => {
          bridgeOpen = true;
          void maybeDispatchInitialPrompt();
        },
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
            if (typeof msg.autoGrantNew === "boolean") setAutoGrantNew(msg.autoGrantNew);
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
              approve: askApproval,
              resolveFields: (paths) => profileStore.resolve(paths),
              dismiss: dismissApproval,
            }).then((reply) => bridgeRef.current?.send(reply));
          }
          if (msg.type === "assistant") {
            setLines((l) => [...l, { kind: "assistant", text: msg.content }]);
          }
          if (msg.type === "error") {
            setLines((l) => [...l, { kind: "system", text: msg.message }]);
            setBusy(false);
          }
        },
      },
      role,
    );
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
      approve: isConsole ? askApproval : undefined,
    });
    registrationRef.current = registration;
    void syncTools(
      registration,
      new Set(seededFromNav ? [seededFromNav] : []),
    ).then(async () => {
      initialSyncDone = true;
      void maybeDispatchInitialPrompt();
    });
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

  const suggestions = (() => {
    const list: string[] = [];
    const origin = pageOrigin || seededFromNav || "";
    if (origin.includes("allbirds")) {
      list.push(
        "Find black running shoes under $120",
        "Compare prices for Wool Runners vs Tree Dashers",
        "Add men's wool runner to cart",
      );
    } else if (origin.includes("brooklinen")) {
      list.push(
        "Find best-selling queen sheet sets",
        "Compare lightweight vs warm duvets",
        "Find any active discount codes",
      );
    } else if (origin.includes("kayak")) {
      list.push(
        "Find flights from NYC to London under $500",
        "Compare flight options for next weekend",
        "Find 4-star hotels in Paris with breakfast",
      );
    } else if (origin.includes("gov.uk")) {
      list.push(
        "Find my local council from postcode",
        "Check vehicle tax rates",
        "Fill council form with my profile details",
      );
    } else {
      list.push(
        "Compare prices for best sellers",
        "Find available discounts and sales",
        "Check reviews and stock availability",
      );
    }
    return list;
  })();

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
        <div className="shell__view-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className="shell__view-btn"
            data-active={viewMode === "normal"}
            onClick={() => setViewMode("normal")}
          >
            Normal view
          </button>
          <button
            type="button"
            className="shell__view-btn"
            data-active={viewMode === "tech"}
            onClick={() => setViewMode("tech")}
          >
            Tech view
          </button>
        </div>
        <ThemeToggle />
      </div>
      <ChatPanel
        tools={tools}
        audit={audit}
        lines={lines}
        busy={busy}
        mode={viewMode}
        suggestions={suggestions}
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
        <Consent
          origins={ORIGINS}
          consented={consented}
          onGrant={(o) => void grant(o)}
          onRevoke={(o) => void revoke(o)}
          autonomous={autonomous}
          onAutonomous={(on) => {
            setAutonomous(on);
            // Carry `autoGrantNew` on every autonomous message: the DO's
            // setter only writes the flag when the field is present, so
            // sending the current value keeps both flags in sync rather
            // than letting the other one drift if the user just toggled
            // the catalog switch.
            bridgeRef.current?.send({
              v: 1,
              type: "autonomous",
              on,
              autoGrantNew,
            });
            setLines((l) => [
              ...l,
              {
                kind: "system",
                text: on
                  ? "autonomous on — demo origins granted"
                  : "autonomous off — new sites need a grant",
              },
            ]);
          }}
          autoGrantNew={autoGrantNew}
          onAutoGrantNew={(on) => {
            setAutoGrantNew(on);
            bridgeRef.current?.send({
              v: 1,
              type: "autonomous",
              on: autonomous,
              autoGrantNew: on,
            });
            setLines((l) => [
              ...l,
              {
                kind: "system",
                text: on
                  ? "auto-grant new on — sites grant as ChatGPT opens them"
                  : "auto-grant new off — new sites need a manual grant",
              },
            ]);
          }}
        />
        {isConsole ? (
          <PasskeyBar
            sessionToken={sessionToken}
            onSignedIn={(id) => {
              // Adopting a different account means different grants. Re-claim
              // this session under it and take what comes back. Step-up is
              // required: the login that produced this id already proved
              // possession of an authenticator, and step-up proves it again
              // against the new account/session binding.
              void (async () => {
                const claimed = await claimWithStepUp(sessionToken, id);
                if (!claimed.ok) return;
                const next = new Set(claimed.consent);
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
        />
      </div>
      <ApprovalDialog
        request={approval}
        onDecide={(ok) => {
          approvalWait.current?.(ok);
          approvalWait.current = null;
          setApproval(null);
        }}
      />
    </div>
  );
}
