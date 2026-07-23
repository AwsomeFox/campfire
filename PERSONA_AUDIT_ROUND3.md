# Persona Audit — Round 3 Findings

**Audited commit:** `fa52628`
**Focus:** Remaining AI areas after R1/R2 (provider adapters, budget enforcement, encounter setup, accessibility, portability, safety enforcement)
**Personas:** QA Engineer, DM/Player Encounter Specialist, Product Owner/Architect

Round 3 reports ONLY genuinely new findings. **6 new findings** (2 High, 4 Medium). Fresh agents were given the full R1+R2+existing-issues exclusion list.

---

## Summary

| Severity | Count |
|----------|-------|
| High | 2 |
| Medium | 4 |

---

## High

### R3-1. Anthropic adapter emits invalid message sequence for parallel/multiple tool calls — wedges multi-tool turns

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**User Story:** As a DM using a Claude/Anthropic model, I want the AI DM to issue multiple tool calls in one step (roll + apply + advance), so turns complete instead of erroring.

**Evidence (verified):** `apps/server/src/modules/ai-dm/providers/anthropic-provider.ts` `toAnthropicMessages()` — the `m.role === 'tool'` branch pushes each tool result as its OWN separate `user` message:
```typescript
out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: ..., content: ... }] });
```
`ai-driver.service.ts` `runTurn()` appends one `tool` message per call after a single assistant turn with N `toolCalls`. So a parallel-tool step serializes to `assistant[tool_use A, tool_use B] → user[tool_result A] → user[tool_result B]`. Anthropic requires ALL `tool_result` blocks for an assistant turn's `tool_use` blocks in the SINGLE immediately-following user message, so the API rejects the next step with HTTP 400. A mid-turn provider throw propagates out before `turn.end`/stuck-detection, leaving the seat without a lever. *(Content about Anthropic's requirement rephrased for compliance with licensing restrictions; see [Anthropic parallel tool use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use).)*

**Distinct from:** R2-1 (Gemini drops tool calls) is a different provider and defect. OpenAI round-trips multiple `tool` messages correctly (valid OpenAI shape, and tested); Anthropic single-tool works and is tested, but multi-tool is neither handled nor tested.

**Acceptance Criteria:**
- `toAnthropicMessages` coalesces consecutive `tool` messages answering the same assistant turn into ONE `user` message with all `tool_result` blocks (in tool_use order)
- Unit test: assistant message with 2 `tool_use` blocks + 2 results → single user message with 2 `tool_result` blocks
- A driver turn with 2+ parallel tool calls completes without a provider 400

---

### R3-2. AI Driver cannot create or configure an encounter — exploration→combat is not AI-driveable end-to-end

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**User Story:** As a player at a solo AI table, when the fiction turns to a fight I want the AI DM to spin up the encounter itself, so I don't need a human to click "New encounter" first.

**Evidence (verified):** `DRIVER_LIVE_PLAY_TOOLS` (`ai-driver.service.ts:221`) includes `begin_encounter`, `add_combatant`, `roll_initiative`, `next_turn`, `end_encounter`, `update_combatant` — but NOT `create_encounter`, `update_encounter`, or `generate_map`. All three are `writeTool`s (mutating) without a `propose` arg (`create_encounter` mcp-tools.ts:2707, `update_encounter` :2734, `generate_map` :2789), so they hit default-deny (`ai-driver.service.ts:389`) and are refused. Encounters have NO proposal path (mcp-tools.ts:220 notes proposals are ignored for encounters). `create_encounter` (2707, "create a new encounter, status=preparing") is distinct from `begin_encounter` (2894, "start an encounter status=running"). Net: the AI can PREVIEW (`generate_encounter`, allowed) and OPERATE a fight (add/begin/next), but a human must call `create_encounter` first. `generate_encounter`'s own guidance ("TO COMMIT: call create_encounter then add_combatant") names exactly the blocked step.

**Distinct from:** R2-6/#1024 (scene/location/faction consequences), combat-log reads, dispositions — none address encounter-SETUP tools missing from the driver allow-list. Encounter operation is fully driveable; encounter setup is entirely blocked — an asymmetry no prior finding names.

**Acceptance Criteria:**
- Add `create_encounter` to the driver live-play allow-list (already DM-role-gated) OR give encounters a proposal path
- Decide + document `update_encounter` / `generate_map` posture for the driver
- Driver integration test for the full exploration→combat commit path (create → add_combatant → roll_initiative → begin_encounter)

---

## Medium

### R3-3. Streamed turns meter 0 tokens when a provider omits streaming usage — budget hard-stop silently bypassed (fail-open)

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `ai-driver.service.ts` `runTurn()` `const usage = result?.usage.totalTokens ?? 0;` then `meterTurn(...)`. OpenAI adapter sets `stream_options.include_usage`, but the adapter also fronts Azure/OpenRouter/Groq and local servers (Ollama/llama.cpp/LM Studio) that may omit streamed usage; `OpenAiStreamAccumulator` records usage only `if (chunk.usage)`, else `{0,0,0}`. Every step then meters 0, `budgetRemaining` never decreases, `budget_exhausted` is never reached, and the console/server-cap aggregate under-reports. (Anthropic emits usage via message_start/delta, so this primarily affects OpenAI-compatible/local providers.)

**Distinct from:** R1-18 (scribe metering not awaited), R1-21 (concurrent budget), R2-4 (no monetary model) — this is a fail-open in the driver's own step metering dependent on whether the provider reports streamed usage.

**Acceptance Criteria:** Missing streamed usage is treated as a metering error / token estimate, or surfaces "budget unenforceable for this provider" — not silent 0. Test: fake provider streaming text + done with no usage still decrements budget (or rejects the turn).

---

### R3-4. Streaming AI narration is not in an ARIA live region — screen readers hear nothing

**Persona:** Product Owner / Architect  
**Labels:** `bug`, `persona-audit`, `theme: ai`, `accessibility`

**Evidence:** `apps/web/src/features/ai-dm/AiTablePage.tsx` (~:430) — the transcript scroll container has no `role="log"`/`role="status"`, `aria-live`, or `aria-atomic`. DM bubbles fill token-by-token from `narration.delta` with no live-region wrapper. Contrast: the same file gives the token meter `role="progressbar"`, `DraftWithAiButton.tsx:255` uses `role="status" aria-live="polite"`, and `StuckLadder.tsx:145` uses `role="status"` — so the pattern is known; the primary AI output is the surface left silent. Auto-scroll is purely visual (`scrollIntoView`).

**Distinct from:** R1/R2 are backend/architecture; #874 is content-level comprehension, not assistive-tech markup. This is a client-side a11y defect on the streaming surface.

**Acceptance Criteria:** Transcript (or a mirror) exposes `role="log"` + `aria-live="polite"` `aria-relevant="additions"`; narration announced incrementally without per-token spam (announce on turn.end or debounce); turn.start/end and composer lock/unlock produce SR-perceivable status; verified with VoiceOver/NVDA.

---

### R3-5. AI seat + scribe configuration is dropped by export, import, AND clone

**Persona:** Product Owner / Architect  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `export.service.ts` `buildExport()` enumerates many entities incl. sessionZero/inventory/treasury/attachments but NOT `aiDmSeats` or `aiScribeConfigs`. `campaigns.service.ts` `clone()` clones locations/npcs/quests/characters/sessions/notes/encounters but never references `aiDmSeats` (imported, used only in `remove()`). `importCampaign()` reconstructs from the export doc, which never carried AI config. Lost non-secret fields: seat `mode/enabled/model/instructions/tokenBudget` (the hand-authored steering is the most valuable prep) and scribe `postSession/cron/budgetPerRun`. Correctly excluded sibling: `aiProviderConfigs` (encrypted key) — so the fix is scoped to non-secret seat/scribe rows.

**Distinct from:** R1-5 (runtime session state across restart) and R2-9 (templating feature). This is the existing export/import/clone plumbing silently omitting rows it should carry.

**Acceptance Criteria:** `buildExport` emits `aiSeat` (mode/enabled/model/instructions/tokenBudget — not runtime counters) and `aiScribeConfig`; `importCampaign` restores them with used=0; `clone` copies seat/scribe (reset counters); provider keys stay excluded; round-trip test.

---

### R3-6. Session-zero safety charter is prompt-only — no server-side enforcement or violation backstop

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** `ai-driver.service.ts` `assembleSystemPrompt()` injects the charter as text ("## Session-zero charter (safety boundaries — MUST respect)") and `GROUNDING_PREAMBLE` adds a respect instruction — that is the entire mechanism. Repo-wide search for `moderat|contentFilter|blocklist|safetyFilter|flagContent` finds only human *comment* moderation, nothing on the narration stream. The asymmetry is telling: secrecy has real layered enforcement (player-scoped `contextPrincipal`, tool allow-list, `redactSecretsFromToolResult`/`scrubDmSecret`) while the safety charter gets zero equivalent. A jailbroken/compromised model (or a provider ignoring the system prompt) producing line-crossing narration has no backstop; it streams to every player before any human sees it.

**Distinct from:** R1/R2 cover tone/pacing config, DM reasoning observability, and player prompt-injection — none address enforcement of safety-charter OUTPUT. This is the gap between configuring lines/veils (a shipped feature) and any mechanism making them binding.

**Acceptance Criteria:** Define + document the posture: either (a) a post-generation content check keyed off structured charter lines with DM alert + auto-pause on suspected violation (withheld/flagged, audited), or (b) an explicit surfaced statement that the charter is advisory and the pause/takeover lever is the safety control; prompt copy stops implying a hard guarantee ("MUST respect" → accurate framing); test with a mock provider emitting charter-crossing text.

---

## Areas Checked With No New Finding (Round 3)

- OpenAI adapter tool-call parsing/streaming — correct and unit-tested
- Anthropic single-tool round-trip — correct and tested (only multi-tool is broken, R3-1)
- Controllers (ai-dm/co-dm/ai-driver) — every route role-gated and campaign-scoped via path param; no cross-campaign body param to spoof
- AI Console `setCaps` — schema-bounded `nonnegative().max(1e9)`, array capped; negative/huge rejected
- `meterTurn`/`takeTurn` — atomic SQL `MIN` clamp, `Math.max(0, floor())`, no overflow
- SSE fan-out (`ai-driver-stream.service.ts`) — Subject + campaignId filter + takeUntil(revoked) + heartbeat; no new leak
- Mobile AiTablePage — `max-w-3xl`, `100dvh`, flex-wrap header, stacked composer; no Medium+ defect
- Model discovery failure, feature versioning/migration, whole-journey solo DM — no new Medium+ beyond filed items
- Whole-party initiative, compendium add_combatant auto-stats, healing/revive/stabilize — adequate
