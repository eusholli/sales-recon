# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Web Tools

### web_search
- **Provider:** Brave Search API (`BRAVE_API_KEY`)
- **Expected latency:** ~1–3s
- **Best for:** All B2B research queries — fast, structured results

### web_fetch
- **Provider:** Built-in HTTP + Firecrawl fallback (`FIRECRAWL_API_KEY`)
- **Expected latency:** ~2–5s
- **Best for:** Extracting content from a specific URL. Firecrawl auto-activates for JS-heavy pages.

## Examples

```markdown
### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
