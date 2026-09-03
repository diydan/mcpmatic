# Positioning and demo

Companion to `docs/superpowers/specs/2026-09-03-session-as-account-design.md`.
That document is the mechanism. This one is the claim and the seven minutes
that prove it.

## The claim

**Your AI agent is a customer of the open web.**

It has money to spend, forms to fill, and bookings to make, and it cannot do
any of it — not because the sites are hostile, but because every site's tools
end at that site's page. mcpmatic is the session that holds your consent and
carries it across origins, calling each site's own tools on your behalf.

## The analogy, and where it breaks

Mobile-friendly sites won the last decade; AI-callable sites will win this one.
The analogy is good and it has one specific failure mode worth knowing before
someone else finds it:

**mobile traffic was visible.** Site owners watched half their visitors arrive
on phones and bounce, in their own analytics, and that number is what forced
the rebuild. Agent traffic is invisible today. No merchant can see that an
agent tried `update_cart` and their schema rejected it.

So the analytics pillar is not a side business. It is the missing feedback loop
that makes the analogy come true — and mcpmatic is uniquely placed to close it,
because it is the thing calling those tools from outside the page.

## What this is not

- **Not a scraper.** We call `search_catalog` because Allbirds registered
  `search_catalog`. Ten tools, theirs, unchanged. The competitive set is
  browser agents that guess at a DOM; we don't guess.
- **Not a checkout.** No payment is submitted. `fill_checkout` fills, and stops.
- **Not "works on any site."** A site that ships WebMCP works fully. A site
  that doesn't needs a mapped manifest, and we have two. Say the true version;
  it is a better story than the inflated one, because the true version has a
  roadmap and the inflated one has a bug report.

## One sentence per audience

- **A person:** one conversation, many sites, and you approve what leaves your
  machine.
- **A site owner:** agents are already calling your tools — here is how that is
  going, and here is why 40% of them fail.
- **An AI app developer:** point your MCP client at one URL and every site your
  user has granted becomes callable tools.

## The demo — seven beats

Two windows on screen throughout: **Claude Desktop** (the agent) and **the
mcpmatic console at `/c/<token>`** (the human). The split screen is the
argument. Everything the agent does, you watch happen in a real browser, and
the moments where it needs you are visible as they occur.

The console is a separate route from the façade `/s/<token>` that an agent
loads, and the split is deliberate: only the console can answer an approval, so
an agent cannot approve on your behalf even though it holds the same token.
Worth one sentence on screen at beat 5.

**0 · Cold open (20s).** Claude Desktop, no mcpmatic. *"Add wool runners in a 9
to my Allbirds cart."* It cannot. Not "refuses" — genuinely has no way.
*Proves: the gap is real, and it is not a model capability problem.*

**1 · Connect (30s).** Add mcpmatic as an MCP server. `tools/list` returns
three tools: `get_page_state`, `list_available_origins`, `navigate_to`. No
merchant tools. Nothing has been granted, so nothing is exposed.
*Proves: consent gates listing, not just execution. Say this line out loud —
it is the difference between a permission system and a confirm dialog.*

**2 · Grant (30s).** In the console, grant `allbirds.com`. Back in Claude
Desktop the tool list now carries `search_catalog_on_allbirds_com`,
`update_cart_on_allbirds_com`, and the rest — origin-qualified, never bare.
*Proves: the human, not the agent, decides the surface.*

**3 · The thesis (60s).** Ask again. Watch the console screencast: a real
browser on the real storefront, and the call lands on **Allbirds' own
`search_catalog` handler** — the same code their theme registered. Say plainly:
*we did not write this tool, and we are not clicking their buttons.*
*Proves: the site owns its tools. This is the whole differentiator.*

**4 · Cross-origin (45s).** Grant a second merchant. One conversation now spans
two stores. Nothing about the first session was disturbed.
*Proves: the thing ChatGPT's per-page model cannot do.*

**5 · The money shot (90s).** *"Fill the checkout."* Claude Desktop's tool call
**suspends** — and it suspends at the console, not at the façade the agent
itself could reach. The console raises a dialog naming the exact fields —
`shopper.firstName`, `address.line1`, `address.postcode` — and where they are
going. Approve. The fields land, the checkout fills, the agent's call returns.

Then do it again and **deny**. The tool fails, honestly, with
*"user denied: profile fields not sent."* No silent success.

*Proves: the consent layer is a mechanism, not a promise. The agent held the
capability; the human held the secret; nothing moved without both.*

**6 · The receipt (30s).** Open the audit log. Every row names the origin, the
tool, and the field names. **There is no value column** — not redacted, not
hashed, absent. "We don't log it" is a policy; "there is nowhere to log it" is
an architecture.
*Proves: the claim is checkable.*

**7 · The turn (30s, roadmap).** Flip to the site-owner view. *This is what
agents did on your storefront this week: 400 calls, 40% of your `update_cart`
rejected because your schema requires a field your own checkout never sends.*
*Proves: there is a business, and it is the feedback loop from §The analogy.*

## The closing line

> Five years from now every site will ship tools for agents. This is what that
> looks like from the user's side, and it works today on stores that already
> shipped them.

## Things not to say

- **Never "your data never leaves your device."** It does — page → Worker → DO
  → the target origin. The store learns your shipping address, legitimately.
  The true claims are narrower and stronger: only declared paths resolve,
  nothing is uploaded wholesale, and there is nowhere to log a value.
- **Don't oversell the passkey.** It logs you into mcpmatic. It cannot log you
  into a merchant — the authenticator is on your device and the browser is in
  Cloudflare's network. That limitation is worth stating; it makes the rest
  more credible.
- **Don't demo a purchase.** `fill_checkout` stops before payment, deliberately.
  A demo that appears to buy something invites the one question the design has
  not answered yet.
- **Don't say "autonomous."** The design's entire value is that a human is in
  the loop at the moment it matters. Beat 5 is the product.

## Open

- Beat 7 needs Phase C. Until then it is a slide, and should be labeled as one
  on screen rather than mocked up as if live.
- Beat 5's suspend/resume is Phase A and does not exist yet. Today the same
  moment happens in the WebMCP façade path only; over MCP it silently fills
  nothing. **Do not record beat 5 before Phase A ships** — it is the beat the
  whole narrative rests on, and it is currently the one that lies.
