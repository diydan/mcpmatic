/**
 * @vitest-environment happy-dom
 *
 * The extraction runs inside the remote page, so it is tested against a real
 * DOM rather than a mocked `evaluate`. Mocking the evaluate would only prove
 * the wrapper forwards a value; the value is the whole feature.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { collectInspection, describeInspection } from "../worker/inspect-site";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("collectInspection", () => {
  it("reads a JSON-LD SearchAction, which a site published on purpose", () => {
    document.head.innerHTML = `<script type="application/ld+json">
      {"@type":"WebSite","potentialAction":{"@type":"SearchAction",
       "target":{"urlTemplate":"https://x.test/search?q={search_term_string}"}}}
    </script>`;
    expect(collectInspection().searchActions).toEqual([
      { urlTemplate: "https://x.test/search?q={search_term_string}" },
    ]);
  });

  it("reads a form's action, method and fields", () => {
    document.body.innerHTML = `
      <form action="/search" method="get">
        <input name="q" type="search" required>
        <input name="page" type="number">
      </form>`;
    const [form] = collectInspection().forms;
    expect(form.method).toBe("get");
    expect(form.action).toContain("/search");
    expect(form.fields).toEqual([
      { name: "q", type: "search", required: true },
      { name: "page", type: "number", required: false },
    ]);
  });

  it("finds a search input that is not inside a form", () => {
    document.body.innerHTML = `<input type="search" name="query">`;
    expect(collectInspection().searchInputs.length).toBe(1);
    expect(collectInspection().searchInputs[0].name).toBe("query");
  });

  it("recognises a search box by name when the type is plain text", () => {
    document.body.innerHTML = `<input type="text" name="q">`;
    expect(collectInspection().searchInputs.length).toBe(1);
  });

  it("counts interactive controls without listing them", () => {
    document.body.innerHTML =
      `<button>a</button><a href="/x">b</a><input name="c"><div role="button">d</div>`;
    expect(collectInspection().interactiveCount).toBe(4);
  });

  it("reports an empty page as empty, not as a failure", () => {
    const out = collectInspection();
    expect(out.forms).toEqual([]);
    expect(out.searchActions).toEqual([]);
    expect(out.searchInputs).toEqual([]);
    expect(out.interactiveCount).toBe(0);
  });

  it("caps the forms it returns, because a page is remote input", () => {
    document.body.innerHTML = Array.from(
      { length: 25 },
      (_, i) => `<form action="/f${i}"><input name="a"></form>`,
    ).join("");
    expect(collectInspection().forms.length).toBe(20);
  });

  it("caps fields within a single form", () => {
    const inputs = Array.from({ length: 40 }, (_, i) => `<input name="f${i}">`).join("");
    document.body.innerHTML = `<form action="/big">${inputs}</form>`;
    expect(collectInspection().forms[0].fields.length).toBe(30);
  });

  it("survives unparseable JSON-LD rather than throwing", () => {
    document.head.innerHTML = `<script type="application/ld+json">not json</script>`;
    expect(collectInspection().searchActions).toEqual([]);
  });

  it("ignores fields with no name, which cannot be filled by name", () => {
    document.body.innerHTML = `<form action="/x"><input type="submit"><input name="q"></form>`;
    expect(collectInspection().forms[0].fields).toEqual([
      { name: "q", type: "text", required: false },
    ]);
  });
});

describe("describeInspection", () => {
  const empty = {
    url: "https://x.test/",
    searchActions: [],
    forms: [],
    searchInputs: [],
    interactiveCount: 0,
    webmcpTools: [],
  };

  it("leads with the site's own tools when it publishes them", () => {
    const text = describeInspection({
      ...empty,
      webmcpTools: [
        { name: "search_catalog", description: "d", inputSchema: { type: "object" } },
      ],
    });
    expect(text).toContain("1 WebMCP tool");
    expect(text).toContain("search_catalog");
  });

  it("says what a site without WebMCP does expose", () => {
    const text = describeInspection({
      ...empty,
      forms: [
        { action: "/search", method: "get", fields: [{ name: "q", type: "search", required: true }] },
      ],
      interactiveCount: 41,
    });
    expect(text).toContain("No WebMCP");
    expect(text).toContain("/search");
    expect(text).toContain("q");
    expect(text).toContain("41");
  });

  it("names a published SearchAction as the strongest signal", () => {
    const text = describeInspection({
      ...empty,
      searchActions: [{ urlTemplate: "https://x.test/s?q={q}" }],
    });
    expect(text).toContain("SearchAction");
    expect(text).toContain("https://x.test/s?q={q}");
  });

  it("says plainly when a page offers nothing, rather than implying a fault", () => {
    const text = describeInspection(empty);
    expect(text).toContain("No WebMCP");
    expect(text.toLowerCase()).not.toContain("error");
    expect(text.toLowerCase()).not.toContain("fail");
  });

  it("never quotes page text or field values", () => {
    const text = describeInspection({
      ...empty,
      forms: [
        { action: "/x", method: "post", fields: [{ name: "email", type: "email", required: true }] },
      ],
    });
    expect(text).toContain("email");
    expect(text).not.toContain("@");
  });
});
