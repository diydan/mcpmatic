/**
 * Does a call satisfy the remote tool's *own* declared schema?
 *
 * This is the one telemetry signal a merchant cannot get anywhere else. Their
 * server logs show a request that never arrived; only something calling their
 * WebMCP tools from outside the page can say "agents tried, and your schema
 * turned them away."
 *
 * Deliberately a subset of JSON Schema — required, declared types, and closed
 * objects. It exists to classify a failure, not to validate input: the remote
 * tool remains the authority on its own arguments. When there is nothing
 * usable to judge against it says so by passing, because "we do not know" must
 * never be reported to a site owner as their bug.
 */

export type SchemaCheck =
  | { ok: true }
  | { ok: false; missing: string[]; wrongType: string[]; unexpected: string[] };

type JsonSchema = {
  type?: unknown;
  properties?: Record<string, { type?: unknown }>;
  required?: unknown;
  additionalProperties?: unknown;
};

export function checkArgs(schema: unknown, args: Record<string, unknown>): SchemaCheck {
  const s = asObjectSchema(schema);
  if (!s) return { ok: true };

  const properties = s.properties ?? {};
  const required = Array.isArray(s.required)
    ? s.required.filter((x): x is string => typeof x === "string")
    : [];

  const missing = required.filter((name) => args[name] === undefined);
  const wrongType: string[] = [];
  const unexpected: string[] = [];

  for (const [name, value] of Object.entries(args)) {
    const declared = properties[name];
    if (!declared) {
      if (s.additionalProperties === false) unexpected.push(name);
      continue;
    }
    if (!matchesType(declared.type, value)) wrongType.push(name);
  }

  if (!missing.length && !wrongType.length && !unexpected.length) return { ok: true };
  return { ok: false, missing, wrongType, unexpected };
}

function asObjectSchema(schema: unknown): JsonSchema | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as JsonSchema;
  if (s.type !== "object") return null;
  return s;
}

function matchesType(declared: unknown, value: unknown): boolean {
  // No declared type is not a mismatch — the schema simply did not say.
  if (declared === undefined) return true;
  const allowed = Array.isArray(declared) ? declared : [declared];
  return allowed.some((t) => matchesOne(t, value));
}

function matchesOne(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    // An integer is a number; a schema asking for one accepts 3.
    case "number":
    case "integer":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      // An unrecognised type is not something we can call wrong.
      return true;
  }
}
