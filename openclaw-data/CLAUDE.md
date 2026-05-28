# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

This is a **configuration and data repository** for an OpenClaw AI agent system — a personal AI assistant platform. There is no build/compile step. Files here define agent behavior, identity, memory, and tool configuration.

## Repository Architecture

```
.openclaw/
├── agents/                   # Per-agent session history (gitignored)
│   ├── main/agent/           # Main agent runtime config (models.json, auth-profiles.json)
│   ├── main/sessions/        # Main agent conversation sessions (gitignored)
│   └── tavily/sessions/      # Tavily-enhanced agent sessions (gitignored)
├── workspace/                # Main agent's working directory
│   ├── AGENTS.md             # Core behavioral rules for the agent
│   ├── SOUL.md               # Agent personality and guiding principles
│   ├── USER.md               # Info about the human (eusholli / Rakuten Symphony)
│   ├── TOOLS.md              # Local environment-specific notes
│   ├── HEARTBEAT.md          # Periodic proactive task list
│   └── memory/               # Daily session notes only (research lives in gbrain)
│       └── YYYY-MM-DD.md     # Daily session notes
├── workspace-tavily/         # Alternate workspace for Tavily web-search agent
│   ├── AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md
│   ├── IDENTITY.md           # Agent's chosen name/persona
│   └── BOOTSTRAP.md          # First-run initialization script (delete after use)
├── workspace-long-context/   # Long-context variant workspace (same structure)
├── openclaw.json             # Main runtime config (model routing, tools, gateway, hooks)
├── mcporter.json             # MCP server configuration
├── identity/                 # Device keypair and ID (gitignored — never commit)
├── canvas/                   # Web UI assets (gitignored)
└── logs/                     # Command logs (gitignored)
```

## Three Agent Configurations

- **`workspace/`** — Main agent ("Symphony Signal" / persona "Kenji"). Direct human conversations. Research is read/written via the `gbrain` MCP server, not local files.
- **`workspace-tavily/`** — Tavily-enhanced agent with web search capability. Has its own `IDENTITY.md` and `BOOTSTRAP.md`.
- **`workspace-long-context/`** — Long-context variant with same structure as the others.

All workspaces share the same file structure but operate independently with separate session histories.

## Applying Configuration Changes

There is no build step. After editing any `.md` or `.json` file, restart the container to apply:

```bash
cd ~/dev/sales-recon && docker compose restart sales-recon-openclaw
```

## Memory System

Research (companies, people, events) lives in **gbrain** (Postgres + pgvector), accessed via the `gbrain` MCP server. The agent reads/writes pages with `gbrain.get_page` / `gbrain.put_page` under slugs `companies/<slug>`, `people/<slug>`, `events/<slug>`. The nightly dream cycle handles archive, embeddings, and salience automatically.

Local `memory/YYYY-MM-DD.md` files are session-continuity notes only — not research storage. See `workspace/AGENTS.md` for the full memory protocol.

## Key Configuration Files

- **`openclaw.json`** — Top-level runtime config: model providers/routing, tool enablement, gateway settings, hooks. The `agents.defaults.model` section sets the primary model and fallback chain.
- **`agents/main/agent/models.json`** — Per-agent model registry generated at runtime. **Must stay aligned with `openclaw.json`** when changing model IDs — mismatches cause routing failures.

## Key Behavioral Files

When modifying agent behavior, these are the authoritative files:
- **`workspace/AGENTS.md`** — Session startup sequence, gbrain memory protocol, safety boundaries, heartbeat configuration, webhook/distribution rules
- **`workspace/SOUL.md`** — Core personality traits and guiding principles (edit with care; tell the user if you change it)
- **`workspace/HEARTBEAT.md`** — Active periodic tasks (keep small to limit token cost)

## Exec Allowlist — single source of truth

`exec-approvals.json` is per-environment state and is gitignored (the file contains a socket token). To keep dev and prod consistent, the entrypoint script (`scripts/docker-entrypoint.release.sh`, `SEED_BINS` near the top of the allowlist-seed block) is the **single source of truth** for which binaries the agent may exec. Any new bin the agent needs must be added to `SEED_BINS` there — never by hand-editing `exec-approvals.json` on one host. The entrypoint verifies on every start that all `SEED_BINS` paths are present in the allowlist and hard-fails if not.

Adhoc intelligence distribution does NOT use `exec` anymore: ws-proxy and viber-proxy auto-POST the `STRUCTURED_REPORT` block to the event-planner webhook. The agent only needs to emit the block.

## Security / Gitignore

The `.gitignore` deliberately excludes:
- `identity/` — device keypair (private key present, never commit)
- `agents/*/sessions/` — conversation history
- `exec-approvals.json` — execution permissions
- `canvas/` — ephemeral web UI
- `logs/` — runtime logs
- `workspace/.openclaw/` and `workspace-tavily/.openclaw/` — runtime state

Do not add or commit any of these. The `workspace/*.md` files and `workspace-tavily/*.md` files **are** tracked and form the agent's shareable configuration.

## User Context

- **User:** eusholli, affiliated with Rakuten Symphony
- **Focus:** B2B sales research, event tracking, target company/person intelligence
- Research artifacts live in **gbrain** (companies/people/events pages); `workspace/memory/` holds only daily session notes
