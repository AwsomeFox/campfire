# Persona Audit — Round 1 Findings

**Audited commit:** `fa52628` (fix(web): keep visible focus-visible ring on step heading; scope wizard h1 test to main (#998))  
**Date:** 2026-07-23  
**Focus:** AI tools, missing AI features, encounter completeness  
**Personas:** QA Engineer, DM/Player Encounter Specialist, Product Owner/Architect

---

## Summary

| Severity | Count | Category |
|----------|-------|----------|
| Critical | 1 | AI Architecture |
| High | 9 | AI Tools, Game Mechanics, State Management |
| Medium | 11 | AI Features, Error Handling, UX |
| Low | 3 | Polish, Monitoring |

---

## Critical

### 1. AI Driver has no conversation persistence — every turn starts with zero history

**Persona:** Product Owner / Architect  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**User Story:** As a player at an AI-run table, I want the AI DM to remember what happened earlier in the session (my character's plan, the NPC dialogue two turns ago, the clue I found), so that the game feels coherent rather than amnesia-ridden.

**Evidence:** [`ai-driver.service.ts` @ `fa52628` L664](https://github.com/AwsomeFox/campfire/blob/fa52628/apps/server/src/modules/ai-driver/ai-driver.service.ts#L664) — each turn builds a fresh `messages` array containing only the current player input:
```typescript
const messages: AiMessage[] = [{ role: 'user', content: wrapUntrustedPlayerInput(input) }];
```
The only "memory" is `session.lastNarration` (one string) and `lastInputs` (one string per campaign for retry). No turn history store, conversation buffer, sliding window, or summarization pipeline exists.

**Expected:** A bounded conversation history (last N turns or summarized context) prepended to messages on each turn. Architecture needs: (a) per-campaign turn log (DB or ring buffer), (b) context-window budget with trim/summarize, (c) recap section for older compressed history.

**Distinct from:** No open issue covers conversation persistence or multi-turn context management.

**Acceptance Criteria:**
- `GET /ai-dm/session` returns `historyLength` showing turns in context
- `runTurn` prepends bounded history from persistent turn log
- Older entries summarized into `## Recent history` system prompt section
- A `driver_turns` table or ring buffer (configurable per campaign)
- E2e test: 3+ turns, AI narration references content from turn 1

---

## High

### 2. No spell slot expenditure tool available to the AI DM

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**User Story:** As an AI DM running live combat, I need to deduct spell slots when a PC or NPC casts a spell so the encounter can't abuse unlimited casting.

**Evidence:**
- `characters.controller.ts:238-244` — REST endpoint exists (`POST :id/spell-slots`)
- `mcp-tools.ts` — No MCP tool wraps this endpoint (searching for "spell" yields only rule-search descriptions)
- `DRIVER_LIVE_PLAY_TOOLS` — No `patch_spell_slots` or equivalent

**Distinct from:** #683 (MCP parity) tracks general gaps but doesn't name spell slots.

**Acceptance Criteria:**
- A `patch_spell_slots` MCP write tool accepting `{characterId, level, delta}`
- Added to DRIVER_LIVE_PLAY_TOOLS
- Returns error when no slots remain at that level
- AI DM can deduct on cast and restore on rest

---

### 3. No structured saving throw / ability check tool

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**User Story:** As an AI DM, when a monster uses a breath weapon I need to call for DEX saves from affected combatants, using the character's actual proficiency/modifier, compare to a DC, and apply half/full damage — in one verifiable operation.

**Evidence:**
- `mcp-tools.ts` — `roll_dice` accepts a free-text expression with optional `dc`. Does NOT accept `characterId`, save ability, or pull character modifiers.
- `characters.service.ts:76` — Character has `saveProficiencies` and `stats`
- AI must manually: read character sheet → compute modifier → construct dice expression → call roll_dice → interpret result → call update_combatant. 3+ tool calls, each prone to hallucination.

**Expected:** A `saving_throw` tool: `{combatantId(s), ability, dc, halfOnSuccess?}` that resolves server-side using actual stats + proficiency. Similarly `ability_check` / `skill_check`.

**Distinct from:** No known issue addresses this. #874 (AI comprehension) is about prompting quality.

**Acceptance Criteria:**
- `saving_throw` tool accepts targets, ability, DC
- Server computes modifier from character stats + proficiency
- Returns per-target pass/fail + roll detail
- Optionally accepts damage + half-on-success for auto-apply
- Added to DRIVER_LIVE_PLAY_TOOLS

---

### 4. No rest mechanic (short rest / long rest)

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**User Story:** As an AI DM running a full adventuring day, when the party takes a short rest I need to restore hit dice HP and certain abilities, and on a long rest restore HP to full, reset spell slots, and clear temporary conditions.

**Evidence:**
- Zero hits for "short rest" or "long rest" in service/controller/MCP code
- No `rest` tool, no `short_rest`/`long_rest` endpoint, no `resetSpellSlots` method
- The AI must manually set each character's HP to max, reset each spell slot level, clear conditions — dozens of tool calls with no atomicity

**Distinct from:** No existing issue tracks rest mechanics. This is a core game-loop mechanic absent from the live-play tool surface.

**Acceptance Criteria:**
- `long_rest` tool resets party HP to max, spell slots, clears non-permanent conditions
- `short_rest` tool allows hit-die-based HP recovery
- Both added to DRIVER_LIVE_PLAY_TOOLS
- Audited and combat-logged
- Rule system adapter customizes recovery rules

---

### 5. In-memory session state lost on server restart

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**User Story:** As a player in an active AI-DM session, I expect the game state to survive a server restart, so that an in-progress vote doesn't vanish, a human takeover isn't silently revoked, and the stuck-ladder levers aren't lost.

**Evidence:** `ai-driver.service.ts:278` — `private readonly sessions = new Map<number, AiDmSessionState>()` is purely in-memory. `getSession()` falls back to `freshSession()`. Same for `lastInputs` — nudge/retry becomes impossible after restart.

**Repro:** Start a session, DM grants human takeover, server restarts → session returns idle/running, takeover silently revoked.

**Acceptance Criteria:**
- Active AI sessions either recover persisted state (DB-backed) OR clients receive clear notification of reset
- In-progress table vote recovered or explicitly expired with stream signal
- Secret-read approvals survive or are audited as revoked
- Acting-DM grants survive restart or seat returns with audited handback

---

### 6. AI Driver has no session lifecycle phases

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**User Story:** As a DM who enabled the AI, I want the AI to greet players when the session starts, offer a recap of last session, and properly wrap up at the end, so the experience feels like a real tabletop session with pacing.

**Evidence:** The AI only responds reactively to `POST /ai-dm/message`. No session "start" trigger, no auto-recap, no wrap-up. `AiDmSessionState` has no phase (greeting → recap → play → wrap-up).

**Distinct from:** The Scribe (#316) only generates post-session recaps; doesn't drive live pacing.

**Acceptance Criteria:**
- `POST /ai-dm/start-session` triggers greeting + last-session recap
- `POST /ai-dm/wrap-up` triggers closing summary
- `phase` field on session state: greeting | active | wrap_up | ended
- System prompt changes per phase
- Table page shows "Start Session" button; DM sees "Wrap Up"

---

### 7. AI Driver is purely reactive — no proactive suggestions

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**User Story:** As a player, I want the AI DM to proactively suggest things (rest after a hard fight, quest hooks, environmental changes) so the game flows naturally without constant prompting.

**Evidence:** The AI only runs via `runTurn()` requiring explicit player input (`POST /ai-dm/message`). No background timers, event-driven triggers, or ambient narration. Stuck-ladder levers still replay the last player input.

**Distinct from:** No known issue covers proactive/autonomous AI initiation.

**Acceptance Criteria:**
- `POST /ai-dm/trigger` for DM-initiated proactive turns
- `ProactiveService` watches campaign events (encounter ended, HP low, objective checked)
- Budget-metered and rate-limited proactive turns
- DM settings toggles per proactive type

---

### 8. AI Driver does not model individual players

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**User Story:** As one of four players at the AI table, I want the AI to address my character by name, remember my individual actions, and handle simultaneous submissions fairly.

**Evidence:**
- `POST /ai-dm/message` takes `input` string; speaker identity prepended client-side as text prefix (`AiTablePage.tsx:272`)
- System prompt (`assembleSystemPrompt`) has NO concept of who's at the table
- Turn serialization means only ONE player can submit at a time — others get 409

**Acceptance Criteria:**
- `/ai-dm/message` payload accepts `characterId` (resolved server-side)
- System prompt includes `## Players at the table` from list_members + get_party
- Optional action queuing for concurrent submissions
- E2e: two players speak in sequence, AI references both by character name

---

### 9. Provider streaming failure leaves all SSE clients with permanently locked composer

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**User Story:** As a player, if the AI provider times out mid-turn, I expect the session to recover so I can retry, not be permanently locked with "A driver turn is already in progress."

**Evidence:** `ai-driver.service.ts:360-400` — if `streamStep` throws (provider error), exception propagates up. The `finally` block resets `session.status` BUT `turn.end` SSE event (line 406) is NEVER emitted because it's AFTER the finally block. All other clients' composers remain locked.

**Repro:** Provider returns 500 mid-stream → clients see `turn.start` but never `turn.end` → composer locked until SSE reconnect.

**Acceptance Criteria:**
- Provider error caught within turn loop, emits `turn.end` with `stopReason: 'provider_error'`
- Session transitions to `awaiting_players` on provider failure
- All SSE subscribers receive turn.end even on error
- Error logged and audited

---

### 10. Conditions have no duration / auto-expiry mechanism

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**User Story:** As an AI DM, when I cast Hold Person (1 minute / concentration), the "paralyzed" condition should automatically expire after 10 rounds, not persist indefinitely.

**Evidence:**
- `encounters.logic.ts` — conditions are `string[]` with no metadata
- `update_combatant` accepts `addConditions/removeConditions` as flat string arrays
- `nextTurn` does NOT check or expire any conditions
- Zero mention of `conditionDuration` or auto-expiry anywhere in the codebase

**Distinct from:** #606 (concentration) is one specific trigger; this covers the general duration infrastructure that ALL conditions lack.

**Acceptance Criteria:**
- Conditions support optional `{duration, source, endsOnTurnStart?}` metadata
- `next_turn` auto-decrements durations and removes expired ones
- Combat log records expiry
- `update_combatant` accepts duration metadata

---

## Medium

### 11. AI system prompt lacks dynamic world-state context

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** `assembleSystemPrompt` reads only campaign summary + session-zero + support preferences. Does NOT inject: current in-world time/date, location, running encounter status, character conditions, or environmental notes.

**Acceptance Criteria:** System prompt includes live game state (calendar, encounter status, conditions, location) via contextPrincipal reads.

---

### 12. No AI customization for tone, pacing, or play style

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** `AiDmSeat` has only `instructions: string` (freeform textarea). No structured fields for tone, pacing, difficulty, verbosity, or NPC voice style.

**Acceptance Criteria:** Seat config gains structured presets (tone, pacing, verbosity, combat style, NPC depth) that map to system-prompt sections.

---

### 13. No server-side transcript — late joiners/device switches lose history

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** Transcript is client-only (localStorage, 200 entries). Late joiners see only `lastNarration`. No paginated history endpoint.

**Acceptance Criteria:** `GET /campaigns/:id/ai-dm/transcript` returns paginated turn history. Table page hydrates from server on mount.

---

### 14. No partial handoff (AI narrates, human decides mechanics)

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** Stuck-ladder handoff is all-or-nothing (`grantTakeover`/`handback`). No "collaborative" mode where AI narrates but defers mechanical decisions.

**Acceptance Criteria:** `collaborative` ladder state; AI pauses at decision points with DM-facing prompts; DM resolves inline.

---

### 15. No provider fallback or retry on transient failure

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** `resolveProviderForExecution` returns single `{provider, model}`. No retry logic, secondary provider, or backoff. Provider failure → 500 + stuck ladder.

**Acceptance Criteria:** 1-2 retries with backoff for 429/5xx; optional fallback provider config; stuck-ladder distinguishes "provider failure" from "tool error."

---

### 16. No attack roll resolution tool

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**Evidence:** No tool combines "roll d20+mod, compare AC, apply damage on hit." AI must chain 3+ tool calls: read AC → roll_dice → update_combatant. Each step risks hallucination.

**Acceptance Criteria:** `attack_roll` tool accepts attacker, target, attack mod, damage expression. Server reads AC, rolls, applies. Critical hit doubles damage dice.

---

### 17. Rate limiting per-IP not per-user — shared NAT/VPN unfairness

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `throttle.constants.ts` — "tracker is IP-based." Players behind same NAT share one 10-req/min bucket. A malicious user can also bypass via IP rotation.

**Acceptance Criteria:** AI throttle keys on authenticated user identity, not solely IP. Independent per-user buckets.

---

### 18. Scribe metering updates tokensUsed but skips turnCount / lastTurnAt

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** [`scribe.service.ts` @ `fa52628` L349–L355](https://github.com/AwsomeFox/campfire/blob/fa52628/apps/server/src/modules/scribe/scribe.service.ts#L349-L355) — the metering transaction updates `aiDmSeats.tokensUsed` only. Unlike [`AiDmService.takeTurn()` @ `fa52628` L336–L338](https://github.com/AwsomeFox/campfire/blob/fa52628/apps/server/src/modules/ai-dm/ai-dm.service.ts#L336-L338), it does not increment `turnCount` or set `lastTurnAt`, so Scribe spend is invisible in seat turn metrics / “last used” UI.

**Acceptance Criteria:** Scribe metering increments `turnCount` and sets `lastTurnAt` in the same seat update as `tokensUsed` (parity with `AiDmService.takeTurn()`); failing meter records status `failed`.

---

### 19. Co-DM cannot draft quests or factions

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** `CoDmDraftTarget = z.enum(['npc', 'location', 'beat', 'recap', 'encounter', 'map'])` — no 'quest' or 'faction' despite both being proposal-capable.

**Acceptance Criteria:** CoDmDraftTarget includes 'quest' and 'faction'. Co-DM generates these as proposals.

---

### 20. Turn continues executing after mid-turn freeze (takeover/pause race)

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `ai-driver.service.ts:362-394` — step loop has no mid-iteration check for `session.state`. If DM grants takeover mid-turn, AI continues streaming narration and executing tool calls. The finally block avoids resetting status but damage (narration, tool calls, budget) already occurred.

**Acceptance Criteria:** Step loop checks session.state between iterations; aborts early if frozen; emits truncated turn.end.

---

### 21. Driver + Scribe concurrent budget spend without coordination

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `assertRunnable()` and scribe's budget check both read `tokenBudget - tokensUsed` independently. Both can pass simultaneously near budget limit. Real-money provider calls happen before the SQL clamp.

**Acceptance Criteria:** Per-campaign advisory lock or optimistic concurrency prevents two spending operations passing budget gate simultaneously.

---

## Low

### 22. Secret-read approvals accumulate unboundedly in memory

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `ai-driver.service.ts:468` — consumed approvals set `consumed = true` but never deleted from the map. `revokeSecretReadApproval` only deletes unconsumed. No periodic cleanup.

**Acceptance Criteria:** Consumed approvals removed after consumption; total active approvals bounded per campaign.

---

### 23. No per-turn token cost history or trend visualization

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** Per-turn cost only in `AiDmTurnRunResult` and `turn.end` SSE — not persisted for DM review. AI Console shows only aggregate rollups.

**Acceptance Criteria:** `GET /campaigns/:id/ai-dm/usage-history` returns per-turn cost records. DM settings shows usage sparkline.

---

### 24. AI Console testAll() has no timeout — hanging provider blocks admin indefinitely

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** [`ai-console.service.ts` `testAll()` @ `fa52628` L226–L265](https://github.com/AwsomeFox/campfire/blob/fa52628/apps/server/src/modules/ai-console/ai-console.service.ts#L226-L265) — sequential loop calling `testConnection` with no `Promise.race` timeout. One hanging provider blocks the entire health endpoint.

**Acceptance Criteria:** Each probe has bounded timeout (15s); timed-out probes return `{ok: false, error: 'timeout'}`.

---

## Discarded / De-duplicated Findings

The following were identified but NOT filed because they overlap with existing open issues:

- AI system prompt hardcoded to English → duplicate of #635 (AI language contract)
- Co-DM uses "D&D content" prompts regardless of ruleset → duplicate of #766
- AI encounter activity linked to wrong fight → duplicate of #825
- AI Table dual SSE connections → duplicate of #880
- No damage type taxonomy in encounters → duplicate of #605
- No concentration check on damage → duplicate of #606
- Dead combatants never skipped → duplicate of #610
- No tiebreak on initiative ties → duplicate of #611
- No lair/legendary/bonus/reaction actions → duplicate of #618
- No AoE multi-target application → duplicate of #626

---

## Build/Test Evidence

```
$ cd /projects/sandbox/campfire
$ git log --oneline -1
fa52628 fix(web): keep visible focus-visible ring on step heading; scope wizard h1 test to main (#998)
```

The audit was performed against the source code directly. Key files examined:
- `apps/server/src/modules/ai-driver/ai-driver.service.ts` (1200+ lines)
- `apps/server/src/modules/mcp/mcp-tools.ts` (3000+ lines)
- `apps/server/src/modules/ai-dm/co-dm.service.ts`
- `apps/server/src/modules/encounters/encounters.service.ts`
- `apps/server/src/modules/encounters/encounters.logic.ts`
- `apps/server/src/modules/characters/characters.service.ts`
- `apps/server/src/modules/scribe/scribe.service.ts`
- `apps/server/src/modules/ai-console/ai-console.service.ts`
- `apps/server/src/common/throttle.constants.ts`
- `apps/web/src/features/ai-dm/AiTablePage.tsx`
- `packages/schema/src/index.ts`

---

## Remaining Known Limitations

1. **Browser/Playwright testing was not performed** — the sandbox environment doesn't support running a dev server and browser automation simultaneously. Findings are based on static code analysis.
2. **Provider integration testing was not performed** — no real LLM provider keys available. Provider behavior inferred from code paths.
3. **Database integration testing was not performed** — SQLite race conditions inferred from code but not reproduced.
4. **The throttle per-IP finding (#17) may not apply in single-user deployments** — it's primarily relevant for shared servers or VPN users.
