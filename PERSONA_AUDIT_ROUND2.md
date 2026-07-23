# Persona Audit — Round 2 Findings

**Audited commit:** `fa52628`
**Focus:** AI tools, missing AI features, encounter completeness (deeper areas Round 1 did not reach)
**Personas:** QA Engineer, DM/Player Encounter Specialist, Product Owner/Architect

Round 2 reports ONLY genuinely new findings not already in Round 1 (`PERSONA_AUDIT_ROUND1.md`) or in existing open issues. **12 new findings.**

---

## Summary

| Severity | Count |
|----------|-------|
| High | 4 |
| Medium | 7 |
| Low | 1 |

---

## High

### R2-1. Gemini provider silently drops every tool call — AI DM on Gemini cannot act

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**User Story:** As a DM using a Gemini model for the AI DM, I want the AI to roll dice, update HP, advance turns, and file proposals, so the AI DM actually functions.

**Evidence:** `apps/server/src/modules/ai-dm/providers/gemini-provider.ts`:
- `buildBody()` advertises tools (`functionDeclarations`) AND serializes messages as text-only (`parts: [{ text }]`) — assistant `toolCalls` and `tool`-role results are never written back into `contents`.
- `parseResult()` and `stream()` extract only `part.text` and hardcode `toolCalls: []`.

The driver (`ai-driver.service.ts` `streamStep`/`runTurn`) depends on structured `result.toolCalls`. With Gemini the AI DM can NEVER call a tool. A tool-only Gemini response (empty text) also makes `classifyStuck()` return `no_narration`, parking the seat as perpetually stuck.

**Distinct from:** Round 1 never examined the provider adapters. No open issue references Gemini or tool-call parsing.

**Acceptance Criteria:**
- Gemini `buildBody` maps assistant tool calls to `functionCall` parts and tool results to `functionResponse` parts
- `parseResult`/`stream` extract `functionCall` parts into `toolCalls`
- Unit tests with recorded Gemini fixtures covering text-only, tool-call, and mixed responses
- E2e: an AI DM turn on a Gemini config successfully executes a `roll_dice` tool call

---

### R2-2. Streaming has no read/idle timeout — a stalled provider stream wedges the entire campaign

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**User Story:** As a player, if the AI provider's stream stalls mid-response (no error, just silence), I want the turn to time out and recover, not permanently lock the campaign so no one can ever take another AI turn.

**Evidence:**
- `apps/server/src/modules/ai-dm/providers/http.ts` — `postJson()` calls `t.cleanup()` (clearing the timeout) immediately after headers arrive, BEFORE returning the streaming `res`. So the per-request timeout only bounds time-to-first-byte, not the body read.
- `apps/server/src/modules/ai-driver/ai-driver.service.ts` `streamStep()` calls `provider.stream()` with no `signal`/timeout.
- A stalled stream never completes → `runTurn()`'s `finally` never runs → `session.status` stays `'running'` → every future turn throws `ConflictException` (409) until server restart; no `turn.end` is ever emitted.

**Distinct from:** Round 1 finding #9 covers the provider-*error* path (turn.end not emitted on thrown error). This is the no-error *stall* path caused by a timeout-scoping defect + missing abort signal, with a distinct "wedge all future turns" harm.

**Acceptance Criteria:**
- Streaming reads enforce an idle/read timeout (abort if no chunk within N seconds)
- The timeout is not cleared until the stream fully completes or aborts
- `streamStep` passes an abort signal; a stalled stream aborts, emits `turn.end` with an error stop reason, and releases the seat
- Test: a stream that stops mid-body triggers recovery, not a permanent 409

---

### R2-3. SSRF via unvalidated provider baseUrl host

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`, `security`

**User Story:** As a server operator, I don't want a campaign DM (non-admin) to be able to point the AI provider baseUrl at internal hosts or cloud metadata endpoints and use the server as a blind SSRF proxy.

**Evidence:**
- `packages/schema/src/index.ts` — `AiProviderBaseUrl` validates only scheme (`http`/`https`) and absence of embedded credentials; no private-IP/host filtering (localhost intentionally allowed for local model servers).
- `POST /campaigns/:id/ai-provider/test` and `/models` require only DM role; `testConnection()` / `fetchAvailableModels()` build a live provider and issue a server-side request to the DM-supplied baseUrl (a non-empty candidate `apiKey` suffices).
- Error kind + latency leak internal-host reachability; `/models` can reflect matching JSON.

**Distinct from:** #373 binds the server key to its own endpoint (exfiltration); its fix intentionally allows arbitrary http hosts. This is the SSRF reachability vector, not credential exfiltration. Nuance: exploitation requires DM role, so severity is bounded — but on a shared/multi-tenant server a campaign DM is not a trusted operator.

**Acceptance Criteria:**
- Optional operator allowlist/denylist for provider hosts; block link-local/metadata ranges (169.254.169.254, etc.) by default with an opt-in for private ranges (local model servers)
- Test-connection errors do not differentiate internal-host reachability beyond a generic failure
- Document the local-model-server exception and how to enable it safely
- Tests covering metadata IP, private range, and public host

---

### R2-4. No monetary cost model — DMs enable paid AI with only a token budget, no $ estimate or disclosure

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**User Story:** As a DM (or self-hoster footing the bill), before I switch the AI DM to Driver I want to understand real-money cost, so I can set a meaningful budget and avoid a surprise provider invoice.

**Evidence:** Every budget/metering surface is token-only:
- `packages/schema/src/index.ts` — `tokenBudget` (tokens)
- `apps/web/src/features/settings/AiDmCard.tsx` `BudgetSection` — "Token budget" + `tokensUsed/tokenBudget` meter; no price, model $/1K, or projected cost
- `apps/server/src/modules/ai-console/ai-console.service.ts` — aggregates by tokens only; grep for `cost|price|usd` = comments only
- Docs describe budgets exclusively in tokens

**Distinct from:** Round 1 #23 is historical per-turn cost *accounting*. This is the absence of any monetary dimension AND pre-enablement cost transparency at the decision point.

**Acceptance Criteria:**
- Provider/model config carries optional per-token pricing (or a built-in table for known models)
- Budget field shows an estimated $ equivalent, or an explicit "Campfire cannot estimate cost — monitor your provider's billing" disclosure when pricing is unknown
- The enablement flow (mode → Driver, onboarding budget step) surfaces the estimate/disclosure before commit

---

## Medium

### R2-5. Scribe post_session trigger over-fires; cron has no cadence

**Persona:** QA Engineer  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `scribe.service.ts` `hasEndedSession()` returns true if ANY scheduled session end is in the past — no "since last run" watermark — so `sweep()` labels runs `post_session` and re-fires whenever new material appears long after the only session. `cron` runs every `SCRIBE_SWEEP_INTERVAL_MS` tick with no cadence config. Idempotency (`sourceHash`) suppresses duplicate proposals, so impact is mislabeled/over-firing rather than duplicate recaps.

**Distinct from:** Round 1 #18 is the scribe metering-transaction bug (different code path).

**Acceptance Criteria:** post_session fires once per session using a per-session watermark; cron respects a configurable cadence; trigger labels are accurate; tests cover multi-session and repeat-sweep.

---

### R2-6. AI Driver cannot transition scenes / move the party between locations

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**Evidence:** `set_location_discovery` (`mcp-tools.ts:1946`) and `update_campaign_status` (`mcp-tools.ts:2491`) are non-proposal `writeTool`s absent from `DRIVER_LIVE_PLAY_TOOLS`, so `isDriverToolAllowed` default-denies them. The seat can create a location (`upsert_location` → proposal) but can never set it "current" or flip unexplored→explored during live play.

**Distinct from:** #1024 covers `set_faction_reputation` + `set_location_discovery` as "world consequences." The **location-discovery portion overlaps #1024** — this finding should be scoped to the DISTINCT part: scene/party-position transitions and `update_campaign_status` for the driver, plus the concept of a "current location" the AI can set. If #1024's scope is expanded to cover location discovery for the driver, fold that portion in.

**Acceptance Criteria:** Driver can mark a location discovered/current during play (guarded live-play or proposal); scene transitions are auditable; distinct from #1024's faction-reputation scope; tests for driver allow-list.

---

### R2-7. No MCP tool to read the persistent per-encounter combat log

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**Evidence:** `EncounterEvent` (schema:3974), `encounters.service.ts:387` `listEvents`, and REST `GET :id/events` (controller:180) exist, but `mcp-tools` only wraps `timeline.listEvents` (in-world timeline), NOT the combat log. `draft_session_recap` pulls combatant rosters but not the round-by-round event trail, so AI recaps/narration lose "what happened during the fight."

**Distinct from:** #683 (MCP parity) enumerates specific gaps but not the combat-event log read.

**Acceptance Criteria:** A read tool (e.g. `list_encounter_events`) exposing the combat log to the AI; role-aware redaction (aligns with #869); scribe/recap source includes the event trail; tests.

---

### R2-8. No set_npc_disposition tool — live social-scene attitude flips can't land in real time

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**Evidence:** NPC disposition (schema:566, first-class friendly/neutral/hostile) can only change via proposal-capable `upsert_npc` — so the driver's forced `propose:true` means a live attitude flip never lands live. There is NO dedicated `set_npc_disposition`/delta tool, unlike factions which got `set_faction_reputation` (`mcp-tools.ts:1831`).

**Distinct from:** #1024 is faction reputation + location discovery, not NPC disposition.

**Acceptance Criteria:** A dedicated `set_npc_disposition` tool (guarded live-play or proposal per policy); parity with faction reputation; audited; tests.

---

### R2-9. AI config doesn't template or carry across campaigns

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** `defaultSeat` (`ai-dm.service.ts`) → mode `off`, budget `0`, instructions `''`. Only the provider inherits server-wide (`EffectiveProviderSection`). No server-default budget/steering/mode; no "copy AI config from campaign X". Multi-campaign DMs re-configure from scratch each time.

**Distinct from:** Round 1 #12 is structured tone/pacing config (content shape). This is cross-campaign reuse/templating of the config that already exists.

**Acceptance Criteria:** Server-default budget/steering inherited by new seats (mirroring provider), and/or a "copy AI configuration from …" action (never the encrypted key); onboarding reflects inherited defaults.

---

### R2-10. Switching AI mode away from Driver doesn't tear down the live driver session

**Persona:** Product Owner / Architect  
**Labels:** `bug`, `persona-audit`, `theme: ai`

**Evidence:** `AiDmService.configure` only upserts the seat row + audits; it never calls into `AiDriverService`. The driver's in-memory `sessions` Map (`ai-driver.service.ts:460`) retains `status`, `state` (incl. `human_control`), `actingDm`, `vote`, `stuck`. A driver→off→driver cycle can strand the seat behind a handback the DM has no obvious reason to perform (`:604` throws "A human is running the table…").

**Distinct from:** Round 1 #5 is state loss across process restart. This is a missing teardown hook in the mode-switch path within a single running process.

**Acceptance Criteria:** Switching to `off`/`co_dm` resets the driver session to fresh idle (clears actingDm/vote/stuck/status/state); emits a lifecycle SSE; re-selecting Driver starts clean; tests.

---

### R2-11. No DM-facing observability into WHY the AI acted

**Persona:** Product Owner / Architect  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`

**Evidence:** Tool SSE events are id-only `{name, isError, proposed}` (`ai-driver.service.ts:841,868,895`); the call `args` are assembled (`:856`) but never emitted. Transcript renders chips only. Per-step audit detail lacks tool name/args/reasoning. The only audit UI is admin-only (`AdminAuditPage`, `isAdmin` nav gate); the campaign-scoped `GET /campaigns/:id/audit` endpoint exists but no web surface consumes it.

**Distinct from:** Round 1 #13 is narration history (transcript API). This is decision/tool-call/reasoning transparency.

**Acceptance Criteria:** A campaign-DM-accessible AI activity log (over `GET /campaigns/:id/audit` and/or richer tool-detail read) showing per-turn tool calls with redaction-safe args/outcomes; provider reasoning captured where available (DM-only, respecting secret redaction); reachable without server-admin rights.

---

## Low

### R2-12. Exhaustion levels and inspiration/hero points are not trackable resources

**Persona:** DM/Player Encounter Specialist  
**Labels:** `enhancement`, `persona-audit`, `theme: ai`, `theme: table-depth`

**Evidence:** Schema has no exhaustion (1–6) or inspiration/hero-point fields; both collapse into opaque free-text conditions with no level/count. The AI cannot increment exhaustion on a failed forced-march save or award/spend inspiration.

**Distinct from:** Round 1 #10 (conditions have no duration/auto-expiry) is a lifecycle concern; this is a representation gap for leveled/counted resources.

**Acceptance Criteria:** First-class exhaustion level + inspiration/hero-point count on the character model; AI tools to adjust them; rule-system-aware; UI display; tests.

---

## Areas Checked With No New Finding (Round 2)

- Provider-config encryption, write-only key, audit terseness, and the #373 key↔endpoint invariant — solid
- `useAiDmStream` parser/reconnect beyond #748/#800 — no new issue
- `AiSetupChecklist` / `StuckLadder` loading/empty/role/ARIA states — solid, state-driven
- Driver tool-scoping/secrecy (#317/#378/#557) and controller authorization — solid
- Death saves (`update_combatant.deathSaveRoll`), temp HP (`hpTemp`) — already supported
- Movement/cover/line-of-sight — no data model exists even for humans (feature absence, not an AI-parity gap)
- Onboarding/discoverability, failure-communication taxonomy (`aiGate.ts`), proposal batch review — mature
- MCP external-client parity — already tracked by #683

---

## De-duplication Note

**Encounter R2-6 (location discovery)** partially overlaps **#1024** ("AI Driver cannot record world consequences — faction reputation and location discovery blocked"), which was filed after Round 1. The distinct residual is scene/party-position transitions and `update_campaign_status` for the driver. If #1024 is expanded to include driver location-discovery, R2-6 should be narrowed accordingly.
