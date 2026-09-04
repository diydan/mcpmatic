/**
 * @vitest-environment node
 *
 * SPEC 4.1: "application logs never record the raw path or token."
 *
 * The capability URL in /s/<token>/... is the session's only credential, and
 * Workers' automatic invocation log records the request URL. This is a guard,
 * not a unit test: it fails if someone re-enables that record, or adds a
 * console call to the Worker that could carry a token into the log.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(raw) as Record<string, unknown>;
}

function workerFiles(dir = "worker"): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return workerFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("the session token never reaches Workers Logs", () => {
  it("has invocation logs disabled", () => {
    const config = readJsonc("wrangler.jsonc") as {
      observability?: { logs?: { invocation_logs?: boolean } };
    };
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });

  it("has tracing off, which would carry the url instead", () => {
    const config = readJsonc("wrangler.jsonc") as {
      observability?: { traces?: { enabled?: boolean } };
    };
    expect(config.observability?.traces?.enabled).not.toBe(true);
  });

  it("logs nothing from the worker itself", () => {
    // Nothing here is allowed to log; a token-bearing path reaches most of
    // these handlers, and the safe thing is a blanket rule rather than an
    // audit of which string is safe.
    const offenders = workerFiles().filter((file) =>
      /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
