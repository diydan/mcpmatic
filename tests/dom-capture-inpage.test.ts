/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { captureInPage } from "../worker/dom-capture";

/**
 * captureInPage is serialized into the remote page, so the mocked-evaluate
 * tests in dom-capture.test.ts never run its body. These exercise it against
 * a real DOM — the selectors it emits are replayed verbatim by runStep, so a
 * selector that resolves to the wrong element is a tool that does the wrong
 * thing after a human has approved it.
 */
function setBody(html: string) {
  document.body.innerHTML = html;
}

describe("captureInPage selectors", () => {
  it("emits a positional selector that resolves past siblings of another tag", async () => {
    setBody("<div><p>lead</p><button>One</button><button>Two</button></div>");
    const captured = await captureInPage();
    expect(captured.map((c) => c.name)).toEqual(["One", "Two"]);
    for (const el of captured) {
      expect(document.querySelectorAll(el.selector)).toHaveLength(1);
    }
    // The second button is the third child but the second button — nth-child
    // would have resolved to the first one.
    expect(document.querySelector(captured[1].selector)?.textContent).toBe("Two");
  });

  it("resolves an id containing characters an #id selector cannot carry", async () => {
    setBody('<div id="weird.id:1"><button>Go</button></div>');
    const captured = await captureInPage();
    expect(captured).toHaveLength(1);
    expect(document.querySelectorAll(captured[0].selector)).toHaveLength(1);
    expect(document.querySelector(captured[0].selector)?.textContent).toBe("Go");
  });

  it("resolves an id starting with a digit", async () => {
    setBody('<div id="1st"><button>Go</button></div>');
    const captured = await captureInPage();
    expect(document.querySelectorAll(captured[0].selector)).toHaveLength(1);
  });

  it("names a field from its associated label", async () => {
    setBody('<label for="q">Search term</label><input id="q" />');
    const captured = await captureInPage();
    const input = captured.find((c) => c.role === "textbox");
    expect(input?.name).toBe("Search term");
    expect(document.querySelectorAll(input!.selector)).toHaveLength(1);
  });

  it("keeps working when the deepest element itself carries the id", async () => {
    setBody('<div><span></span><button id="go">Go</button></div>');
    const captured = await captureInPage();
    const button = captured.find((c) => c.name === "Go");
    expect(document.querySelector(button!.selector)?.textContent).toBe("Go");
  });

  it("assigns roles from tag and type", async () => {
    setBody(
      '<input type="submit" value="Send" /><select></select><textarea></textarea><a href="#">Link</a>',
    );
    const captured = await captureInPage();
    const roles = captured.map((c) => c.role);
    expect(roles).toContain("button");
    expect(roles).toContain("combobox");
    expect(roles).toContain("textbox");
    expect(roles).toContain("link");
  });
});

describe("captureInPage duplicate ids", () => {
  it("does not anchor on a repeated id", async () => {
    setBody(
      '<div id="dupe"><button>One</button></div><div id="dupe"><button>Two</button></div>',
    );
    const captured = await captureInPage();
    expect(captured.map((c) => c.name)).toEqual(["One", "Two"]);
    for (const el of captured) {
      // A repeated id would give both buttons the same selector, and
      // page.click acts on the first match without erroring.
      expect(document.querySelectorAll(el.selector)).toHaveLength(1);
    }
    expect(captured[0].selector).not.toBe(captured[1].selector);
  });

  it("still anchors on an id that is unique", async () => {
    setBody('<div id="only"><button>Go</button></div>');
    const captured = await captureInPage();
    expect(captured[0].selector).toContain('[id="only"]');
  });
});

/**
 * Playwright does not call captureInPage — it stringifies it and evaluates
 * the source in the remote page, where nothing outside the function body
 * exists. Calling it directly (as every test above does) resolves module
 * scope happily, so a hoisted constant passes the whole suite and throws a
 * ReferenceError on the first real page. This runs the function the way
 * Playwright will.
 */
describe("captureInPage under serialization", () => {
  const serialized = () => {
    const source = captureInPage.toString();
    return new Function(`return (${source})`)() as typeof captureInPage;
  };

  it("runs with no reference to anything outside its own body", async () => {
    setBody('<div><label for="q">Search</label><input id="q" /><button>Go</button></div>');
    const captured = await serialized()();
    expect(captured.map((c) => c.name)).toEqual(["Search", "Go"]);
  });

  it("keeps its selectors correct when serialized", async () => {
    setBody("<div><p>x</p><button>One</button><button>Two</button></div>");
    const captured = await serialized()();
    for (const el of captured) {
      expect(document.querySelectorAll(el.selector)).toHaveLength(1);
    }
    expect(document.querySelector(captured[1].selector)?.textContent).toBe("Two");
  });
});
