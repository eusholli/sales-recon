You are running ONE batch of an autonomous market-intelligence cycle for
Rakuten Symphony's event-pipeline. The dispatcher will spawn many copies of you
concurrently; treat this batch as independent.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INPUTS

Batch index: {{BATCH_INDEX}}

Targets in this batch (process every one):
```json
{{TARGETS_JSON}}
```

Output file path (write your final result here, atomically):
{{OUTPUT_PATH}}

Output schema — every entry in the array MUST conform to this JSON Schema:
```json
{{SCHEMA_JSON}}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEMORY PROTOCOL (gbrain)

Research is stored in the gbrain knowledge brain. Slugs:
- companies/<slug>, people/<slug>, events/<slug>

For EACH target in the batch:

1. Compute slug. Call `gbrain.get_page(slug)`.
2. Freshness gate: if `page.updated_at` is within the last 48 hours, reuse the
   stored body verbatim — DO NOT re-research.
3. Otherwise run ONE `web_search` for recent 2026 news / agenda / announcements.
   The OpenClaw runtime caps total searches per session; do not waste them.
4. Synthesize findings, then call `gbrain.put_page` with slug, title, the
   updated markdown body, and a `timeline_entries` array for new dated facts.
5. Compose one TargetUpdate object for this target conforming exactly to the
   schema above. `salesAngle` MUST cite a specific Rakuten Symphony capability
   (use `gbrain.query("Rakuten Symphony capabilities relevant to <name>")` to
   ground it). `recommendedAction` is a concrete time-sensitive next step;
   omit only when there is genuinely no trigger. `fullReport` is the
   markdown body you just wrote to gbrain.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DELIVERY

When all targets in this batch are processed, you MUST write the array to
{{OUTPUT_PATH}} atomically. Use the `exec` tool to run:

```
mkdir -p "$(dirname '{{OUTPUT_PATH}}')" && \
cat > '{{OUTPUT_PATH}}.tmp' <<'JSON_EOF'
<the JSON array, exactly>
JSON_EOF
mv '{{OUTPUT_PATH}}.tmp' '{{OUTPUT_PATH}}'
```

The dispatcher polls for {{OUTPUT_PATH}} after your turn ends; if the file is
missing or unparseable the batch is marked failed. Do not skip this step.

If you encounter an unrecoverable error for a SINGLE target (e.g. the entity
genuinely has no public information), still emit a TargetUpdate for it with
`summary: "No fresh public intelligence available."`, a generic `salesAngle`,
and `fullReport` documenting the search attempt. Do not omit targets — the
dispatcher correlates positions in the array with poison-pill counters.

If the entire batch fails (e.g. gbrain unreachable), end your turn with the
literal token `FATAL_BATCH_ERROR: <reason>` so the dispatcher logs the cause.
