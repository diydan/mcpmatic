import { runTurn, type ModelEnv } from "./agent";
import { NAME_RE, sanitizeSchema } from "./native-webmcp";
import { originSlug } from "../shared/origin";
import type { ManifestStep, ToolManifest } from "../shared/manifest";
import type { PageElement } from "./dom-capture";

export type GenerateOutcome =
  | { ok: true; manifests: ToolManifest[] }
  | { ok: false; reason: "invalid-response" | "threw"; error?: string };

const STEP_ACTIONS = new Set(["goto", "fill", "type", "click", "press", "wait"]);

function buildPrompt(origin: string, elements: PageElement[]): string {
  const lines = elements
    .map((e) => `- role=${e.role} name=${JSON.stringify(e.name)} selector=${e.selector}`)
    .join("\n");
  return [
    `Propose WebMCP tools for ${origin} from the interactive elements below.`,
    `Reply with ONLY a JSON array, no markdown fence, no prose. Each item:`,
    `{"name": string, "description": string, "inputSchema": {"type":"object","properties":{...},"required":[...]}, "steps": [...]}`,
    `Step shapes: {"action":"goto","url":string} | {"action":"fill"|"type","selector":string,"from":string} | {"action":"click","selector":string} | {"action":"press","selector":string,"key":string} | {"action":"wait","selector":string}.`,
    `"from" in a fill/type step must name a property in that tool's own inputSchema.`,
    `Only propose tools for actions actually available below — search, filter, or lookup. Never propose a tool that completes a purchase, payment, checkout, or any other irreversible action.`,
    `Elements:`,
    lines,
  ].join("\n");
}

function validateStep(raw: unknown): ManifestStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.action !== "string" || !STEP_ACTIONS.has(s.action)) return null;
  if (s.action === "goto") {
    return typeof s.url === "string" ? { action: "goto", url: s.url } : null;
  }
  if (s.action === "fill" || s.action === "type") {
    return typeof s.selector === "string" && typeof s.from === "string"
      ? { action: s.action, selector: s.selector, from: s.from }
      : null;
  }
  if (s.action === "click") {
    return typeof s.selector === "string" ? { action: "click", selector: s.selector } : null;
  }
  if (s.action === "press") {
    return typeof s.selector === "string" && typeof s.key === "string"
      ? { action: "press", selector: s.selector, key: s.key }
      : null;
  }
  if (s.action === "wait") {
    return typeof s.selector === "string" ? { action: "wait", selector: s.selector } : null;
  }
  return null;
}

/**
 * One tool, fully validated before it can reach storage. A single bad step
 * drops the whole tool rather than a partial one: a manifest is replayed as
 * a sequence, so a tool missing its middle step is not a smaller tool, it is
 * a tool that does something the human never reviewed.
 */
function validateManifest(raw: unknown, origin: string): ToolManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name.trim()) return null;
  if (typeof m.description !== "string") return null;
  if (!Array.isArray(m.steps) || m.steps.length === 0) return null;
  const steps: ManifestStep[] = [];
  for (const rawStep of m.steps) {
    const step = validateStep(rawStep);
    if (!step) return null;
    steps.push(step);
  }
  // The model is not trusted to origin-qualify its own names; the worker
  // enforces it afterward, the same shape shared/stores.ts produces.
  const base = m.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const qualifiedName = `${base}_on_${originSlug(origin)}`.slice(0, 128);
  if (!NAME_RE.test(qualifiedName)) return null;
  return {
    name: qualifiedName,
    description: m.description.slice(0, 500),
    origin,
    inputSchema: sanitizeSchema(m.inputSchema) as ToolManifest["inputSchema"],
    steps,
  };
}

/**
 * Ask the model to propose tools for an origin from a DOM snapshot, and
 * validate every field of what comes back before any of it is storable.
 *
 * Called only from the background generation path — never inside a tool
 * call's request/response cycle. Nothing returned here is callable: the
 * caller stores these as drafts, and a human blesses each one first.
 */
export async function generateManifest(
  env: ModelEnv,
  origin: string,
  elements: PageElement[],
): Promise<GenerateOutcome> {
  try {
    const decision = await runTurn(
      env,
      [{ role: "user", content: buildPrompt(origin, elements) }],
      [],
    );
    if (decision.kind !== "message") {
      return { ok: false, reason: "invalid-response", error: "model returned a tool call" };
    }
    const cleaned = decision.content
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, reason: "invalid-response", error: "not valid JSON" };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "invalid-response", error: "expected a JSON array" };
    }
    const manifests: ToolManifest[] = [];
    for (const item of parsed) {
      const manifest = validateManifest(item, origin);
      if (manifest) manifests.push(manifest);
    }
    if (manifests.length === 0) {
      return { ok: false, reason: "invalid-response", error: "no valid tools in response" };
    }
    return { ok: true, manifests };
  } catch (err) {
    return {
      ok: false,
      reason: "threw",
      error: err instanceof Error ? err.message : "generation failed",
    };
  }
}
