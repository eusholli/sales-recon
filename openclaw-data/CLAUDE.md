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
│   ├── MEMORY.md             # Long-term curated agent memory (main session only)
│   └── memory/               # Agent memory files
│       ├── YYYY-MM-DD.md     # Daily session notes
│       └── *.md              # Topic-specific long-term memory
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

- **`workspace/`** — Main agent ("Symphony Signal" / persona "Kenji"). Direct human conversations. Reads `MEMORY.md` only in main sessions for privacy.
- **`workspace-tavily/`** — Tavily-enhanced agent with web search capability. Has its own `IDENTITY.md` and `BOOTSTRAP.md`.
- **`workspace-long-context/`** — Long-context variant with same structure as the others.

All workspaces share the same file structure but operate independently with separate session histories.

## Applying Configuration Changes

There is no build step. After editing any `.md` or `.json` file, restart the container to apply:

```bash
cd ~/dev/sales-recon && docker compose restart sales-recon-openclaw
```

## Memory System

The agent uses a two-tier memory model:

1. **Daily files** (`memory/YYYY-MM-DD.md`) — Raw session logs, recent context
2. **Long-term** (`memory/MEMORY.md`) — Curated, distilled knowledge (only loaded in main sessions for privacy)
3. **Topic files** (`memory/Person_Name.md`, `memory/Event_Summary.md`) — Structured research artifacts

When adding memory files, follow these conventions:
- Daily notes: `memory/YYYY-MM-DD-HHMM.md` (timestamped resets)
- Person profiles: `memory/FirstName_LastName.md`
- Event summaries: `memory/EventName_YYYY_Summary.md`

## Key Configuration Files

- **`openclaw.json`** — Top-level runtime config: model providers/routing, tool enablement, gateway settings, hooks. The `agents.defaults.model` section sets the primary model and fallback chain.
- **`agents/main/agent/models.json`** — Per-agent model registry generated at runtime. **Must stay aligned with `openclaw.json`** when changing model IDs — mismatches cause routing failures.

## Key Behavioral Files

When modifying agent behavior, these are the authoritative files:
- **`workspace/AGENTS.md`** — Session startup sequence, memory rules, safety boundaries, group chat guidelines, heartbeat configuration, research decision tree
- **`workspace/SOUL.md`** — Core personality traits and guiding principles (edit with care; tell the user if you change it)
- **`workspace/HEARTBEAT.md`** — Active periodic tasks (keep small to limit token cost)
- **`workspace/MEMORY.md`** — Agent's long-term curated memory (hard cap: 200 lines; only loaded in main sessions)

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
- Research artifacts live in `workspace/memory/` (event summaries, person profiles, company notes)
