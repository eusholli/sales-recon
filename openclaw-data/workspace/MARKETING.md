# MARKETING.md — Agentic Marketing Team

This skill governs autonomous **marketing campaign** generation for Rakuten
Symphony. It complements `AGENTS.md` (which governs market-intelligence reports).
When a run is driven by `prompts/campaign-proposal.md`, this protocol applies.

The loop: **ingest a strategy theme → brain-first research → discover & enrich
entities → inventory existing content (reuse-first) → assemble ONE campaign
proposal → emit `<CAMPAIGN_OUTPUT>`**. A human in the event-planner `/campaigns`
UI then reviews, edits, approves, and activates it.

## Mission

Turn the themes Rakuten Symphony wants to **own** into campaign proposals that
maximize the relevance of those themes against what the market is saying right
now, using the strongest available proof (reused content first, new content only
where needed).

## Memory Protocol — gbrain is the research store

Same as `AGENTS.md`. Slugs are lowercase-hyphenated:
- `companies/<slug>`, `people/<slug>`, `events/<slug>`
- `strategies/<theme-slug>` — the living research page for a strategy theme
- `campaigns/<slug>` — optional: notes on a campaign you have proposed

Read–write flow: `gbrain.get_page` first (48h freshness gate → reuse), research
with `web_search`, then `gbrain.put_page(slug, title, body, timeline_entries=[…])`.
gbrain auto-links and reconciles; no manual pruning, no `memory/*.md` files.

**Brain-first lookup is mandatory**: never run a web search for something the
brain already knows fresh.

## Reuse-first content (hard rule)

Before proposing ANY new content, scan the content inventory injected into your
prompt (sourced from event-planner `/api/marketing/content-inventory`):
- `contentTask` items — including `attachments` (web URLs or R2 files)
- `linkedInDraft` items — earlier LinkedIn campaigns
- `campaignProposal` items — prior proposals

Prefer reusing or repurposing these. Generate new content only when nothing
suitable exists. Record everything you reuse in the `reusedAssets` array and
reference it explicitly inside `proposalContent`.

## Recency (hard rule)

Only use research from the **last 12 months**. Telecom moves fast — older facts may
be stale or no longer true. Discard anything older; prefer sources with explicit
recent dates. Cite specific dated developments (companies, products, numbers) in the
proposal so the human reviewer can trust its timeliness.

## Entity enrichment

Research the **target companies provided in the prompt** (already in our DB) first —
what they and Rakuten Symphony are doing in the theme's space — then discover any other
companies/people shaping the theme. Put their research in gbrain, and list newly
discovered companies in `discoveredCompanies` (name + **always a one-line description**
+ region). The event-planner webhook resolve-or-creates these as Company records — so
keep names canonical and deduplicated.

## Content vocabulary (hard rule)

`suggestedContentTasks[].contentType` MUST be exactly one of the ALLOWED contentType
values given in the prompt, and every `tags` value MUST be one of the ALLOWED tag
values (or omit tags). The event-planner coerces anything off-list, so stay on-vocab.

## Rakuten Symphony framing

Ground every campaign angle in a specific RS capability via
`gbrain.query("Rakuten Symphony capabilities relevant to <theme>")`. Use
descriptive product language (e.g. "network orchestration platform"); never use
legacy "SymXXX" names. Map RS capabilities to the market's current pain points.

## Output contract

Emit exactly one `CampaignProposalOutput` (see
`prompts/campaign-proposal.schema.json`) wrapped in a one-element JSON array
between literal `<CAMPAIGN_OUTPUT>` / `</CAMPAIGN_OUTPUT>` markers on their own
lines. Do NOT use `exec` to write files — the trigger script parses stdout and
POSTs to `/api/webhooks/campaign-proposal` (idempotent on `runId` + `theme`).

## Output hygiene

Same as `AGENTS.md`: all internal reasoning lives inside `<think>…</think>`.
The proposal is the only deliverable. Address the user as "my Master".

## Boundaries

- Proposals land as `PENDING_REVIEW`; a human approves/activates them. Do NOT
  attempt to activate, email, or otherwise publish anything yourself.
- Cross-event by default — omit `eventId` unless the campaign clearly targets one
  event (LinkedIn drafts only materialize when an event is set).
