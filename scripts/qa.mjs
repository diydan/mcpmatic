/**
 * QA smoke for the hosted-UI any-URL feature against
 * https://browsermatic.dev.
 *
 * Drives Chromium headless via Playwright. Covers the Home page
 * (Header presence, disabled state, valid/invalid submissions,
 * origin grid) and a smoke check on the Session page (Header
 * presence, ThemeToggle, chat__bar removed). Skips Session-page
 * navigate_to flows because they trigger Cloudflare Browser
 * Rendering sessions — slow and costly.
 *
 * Output: human-readable per-check PASS/FAIL plus screenshots
 * in scripts/qa-screenshots/.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://browsermatic.dev";
const SHOTS = new URL("./qa-screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ""}`);
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  ctx.setDefaultTimeout(10_000);

  // ---------------------------------------------------------------------
  console.log("\n# Home page");
  const home = await ctx.newPage();
  await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await shot(home, "01-home-initial");

  // Header presence
  const headerInput = home.locator(".header__input");
  check("Home: .header__input is visible", await headerInput.isVisible());
  check(
    "Home: placeholder reads https://example.com",
    (await headerInput.getAttribute("placeholder")) === "https://example.com",
  );
  const goBtn = home.locator(".header__submit");
  check("Home: .header__submit (Go) is visible", await goBtn.isVisible());
  check(
    "Home: Go button starts disabled (empty input)",
    await goBtn.isDisabled(),
  );

  // Demo origin grid still renders
  const cards = home.locator(".use-case");
  check(
    "Home: demo-origin grid renders 3 cards",
    (await cards.count()) === 3,
    `count=${await cards.count()}`,
  );
  const card0Text = (await cards.nth(0).innerText()).toLowerCase();
  check(
    "Home: first card mentions allbirds",
    card0Text.includes("allbirds"),
    card0Text.split("\n")[0],
  );

  // Old "Open a session" button is gone
  const oldBtn = home.getByRole("button", { name: /open a session/i });
  check(
    "Home: legacy 'Open a session' button is gone",
    (await oldBtn.count()) === 0,
  );

  // ----- Happy path: valid https URL -----
  console.log("\n## Happy path");
  await headerInput.fill("https://allbirds.com");
  check(
    "Home: Go button enables after typing",
    await goBtn.isEnabled(),
  );
  await shot(home, "02-home-filled-valid");
  await Promise.all([
    home.waitForURL(/\/s\/[a-f0-9]{64}$/, { timeout: 10_000 }),
    goBtn.click(),
  ]);
  check(
    "Home: submission with https://allbirds.com lands on /s/<token>",
    /\/s\/[a-f0-9]{64}$/.test(home.url()),
    home.url(),
  );
  await shot(home, "03-session-after-home-submit");

  // ----- Session page smoke (after landing) -----
  console.log("\n# Session page (smoke)");
  // The browser-launched session may not fully bootstrap (the Worker
  // Browser Rendering binding isn't reachable from this Chromium), so
  // we only verify static markup: the new Header is present at the top
  // and the old chat__bar is gone.
  const sessionHeaderInput = home.locator(".shell__top .header__input");
  check(
    "Session: Header input is in .shell__top at top of page",
    await sessionHeaderInput.isVisible(),
  );
  const sessionNavBtn = home.locator(".shell__top .header__submit");
  check(
    "Session: Navigate button visible",
    await sessionNavBtn.isVisible(),
  );
  const navLabel = (await sessionNavBtn.innerText()).toLowerCase();
  check(
    "Session: submit label is 'navigate'",
    navLabel.includes("navigate"),
    navLabel,
  );
  const themeToggle = home.locator(".shell__top .theme-toggle");
  check(
    "Session: ThemeToggle is in .shell__top",
    await themeToggle.isVisible(),
  );
  const oldBar = home.locator(".chat__bar");
  check(
    "Session: old .chat__bar is gone",
    (await oldBar.count()) === 0,
  );

  // ----- Validation failures on Home -----
  console.log("\n# Home: validation rejections");
  // Re-open Home and test each rejection case.
  for (const [input, expected] of [
    ["not-a-url", "invalid origin"],
    ["http://example.com", "invalid origin"],
    ["https://127.0.0.1", "invalid origin"],
    ["https://192.168.1.1", "invalid origin"],
    ["https://169.254.169.254", "invalid origin"],
    ["file:///etc/passwd", "invalid origin"],
  ]) {
    await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await home.locator(".header__input").fill(input);
    await home.locator(".header__submit").click();
    // Wait for the error <p> to become visible (React state propagation
    // lands after the fetch resolves, which may be after networkidle).
    const errEl = home.locator(".header__error");
    let visible = false;
    let text = "";
    try {
      await errEl.waitFor({ state: "visible", timeout: 5000 });
      visible = true;
      text = (await errEl.innerText()).toLowerCase();
    } catch {
      visible = false;
    }
    check(
      `Home: "${input}" → "${expected}" inline`,
      visible && text.includes(expected),
      visible ? text : "no .header__error visible",
    );
    await shot(home, `04-home-reject-${input.replace(/[^\w]+/g, "_")}`);
  }

  // ----- Whitespace trimming -----
  console.log("\n# Home: whitespace trimming");
  await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await home.locator(".header__input").fill("   https://example.com   ");
  await Promise.all([
    home.waitForURL(/\/s\/[a-f0-9]{64}$/, { timeout: 10_000 }),
    home.locator(".header__submit").click(),
  ]);
  check(
    "Home: leading/trailing whitespace trimmed → navigates",
    /\/s\/[a-f0-9]{64}$/.test(home.url()),
  );

  // ----- Lenient URL parsing (auto-prepend https://) -----
  console.log("\n# Home: lenient URL parsing");
  for (const bare of ["example.com", "www.example.com"]) {
    await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await home.locator(".header__input").fill(bare);
    await Promise.all([
      home.waitForURL(/\/s\/[a-f0-9]{64}$/, { timeout: 10_000 }),
      home.locator(".header__submit").click(),
    ]);
    check(
      `Home: "${bare}" accepted and lands on /s/<token>`,
      /\/s\/[a-f0-9]{64}$/.test(home.url()),
      home.url(),
    );
    await shot(home, `06-home-lenient-${bare.replace(/\./g, "_")}`);
  }

  // ----- Session page reflects pre-seeded consent -----
  // After typing "example.com" the consent list must contain
  // "https://example.com" on the Session page (the grace note from
  // GET /s/<token>/consent hydration).
  console.log("\n# Session: seeded consent visible");
  await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await home.locator(".header__input").fill("example.com");
  await Promise.all([
    home.waitForURL(/\/s\/[a-f0-9]{64}$/, { timeout: 10_000 }),
    home.locator(".header__submit").click(),
  ]);
  // Look for the system line the hydration effect posts.
  const consentNote = home.locator(".chat__log p").filter({
    hasText: /pre-granted https:\/\/example\.com from session create/,
  });
  let consentVisible = false;
  try {
    await consentNote.first().waitFor({ state: "visible", timeout: 5000 });
    consentVisible = true;
  } catch {
    consentVisible = false;
  }
  check(
    'Session: "pre-granted https://example.com from session create" line visible',
    consentVisible,
  );
  await shot(home, "07-session-seeded-consent");

  // ----- Responsive: narrow viewport stacks form vertically -----
  console.log("\n# Responsive");
  await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await home.setViewportSize({ width: 480, height: 800 });
  const formDir = await home.locator(".header__form").evaluate(
    (el) => getComputedStyle(el).flexDirection,
  );
  check(
    "Home: narrow viewport stacks form vertically",
    formDir === "column",
    `flex-direction=${formDir}`,
  );
  await shot(home, "05-home-narrow");
  await home.setViewportSize({ width: 1280, height: 800 });
  const formDirWide = await home.locator(".header__form").evaluate(
    (el) => getComputedStyle(el).flexDirection,
  );
  check(
    "Home: wide viewport lays form out horizontally",
    formDirWide === "row",
    `flex-direction=${formDirWide}`,
  );
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${passed} passed, ${failed} failed (of ${results.length}) ===`);
process.exit(failed === 0 ? 0 : 1);
