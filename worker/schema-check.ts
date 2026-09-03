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

type PropertySchema = {
  type?: unknown;
  properties?: Record<string, PropertySchema>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
};

type JsonSchema = PropertySchema;

export function checkArgs(schema: unknown, args: Record<string, unknown>): SchemaCheck {
  const found: Mismatch = { missing: [], wrongType: [], unexpected: [] };
  walk(schema, args, "", found, 0);
  if (!found.missing.length && !found.wrongType.length && !found.unexpected.length) {
    return { ok: true };
  }
  return { ok: false, ...found };
}

type Mismatch = { missing: string[]; wrongType: string[]; unexpected: string[] };

/**
 * Real schemas nest. Shopify's `update_cart` declares `required: ["cart"]` at
 * the top and the field that matters, `line_items`, one level down; a checker
 * that reads only the top level passes `{cart:{}}` straight through, and that
 * is precisely the call a merchant needs to hear about. Paths are reported
 * dotted (`cart.line_items`) so they name the field rather than the wrapper.
 *
 * Depth-bounded: a schema is remote input, and a pathological or cyclic one
 * must not become a way to spend this Worker's CPU.
 */
const MAX_DEPTH = 6;

function walk(
  schema: unknown,
  value: unknown,
  path: string,
  found: Mismatch,
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  const s = asObjectSchema(schema);
  if (!s) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;

  const args = value as Record<string, unknown>;
  const properties = s.properties ?? {};
  const required = Array.isArray(s.required)
    ? s.required.filter((x): x is string => typeof x === "string")
    : [];

  for (const name of required) {
    if (args[name] === undefined) found.missing.push(join(path, name));
  }

  for (const [name, arg] of Object.entries(args)) {
    const declared = properties[name];
    if (!declared) {
      if (s.additionalProperties === false) found.unexpected.push(join(path, name));
      continue;
    }
    if (!matchesType(declared.type, arg)) {
      found.wrongType.push(join(path, name));
      // Type is already wrong; descending would report the same fault twice.
      continue;
    }
    if (declared.type === "object") {
      walk(declared, arg, join(path, name), found, depth + 1);
      continue;
    }
    if (declared.type === "array" && Array.isArray(arg) && declared.items) {
      // Every element answers to the same schema; report by index so a
      // merchant can see which item in the batch was malformed.
      arg.forEach((element, i) =>
        walk(declared.items, element, `${join(path, name)}[${i}]`, found, depth + 1),
      );
    }
  }
}

function join(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
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
