import { createZodDto } from 'nestjs-zod';
import { EncounterCreate, EncounterGenerate, EncounterPreviewRequest, EncounterCommit, EncounterUpdate, EncounterEscalationUpdate, EncounterReopen, CombatantCreate, CombatantUpdate, DeathSaveRollRequest, CombatantTurnStatePatch, EncounterEndTurn, EncounterNextTurn, RollRequest, ActionRollRequest, ManualRollRequest, MapPing, ExpectedUpdatedAt, ActionResolveRequest, ActionApplyRequest, ActionUndoToken, TokenBatchPreviewRequest, TokenBatchApply, TokenBatchUndo, SavedTokenFormation } from '@campfire/schema';

export class EncounterCreateDto extends createZodDto(EncounterCreate.strict()) {}
// Encounter generator request (issue #304). .strict() so an unknown/misspelled key 400s
// rather than being silently dropped, consistent with the other encounter write bodies.
export class EncounterGenerateDto extends createZodDto(EncounterGenerate.strict()) {}
// Preview-and-tune wizard (issue #412). .strict() rejects unknown keys. The nested tune op is a
// discriminated union already validated by the zod schema.
export class EncounterPreviewDto extends createZodDto(EncounterPreviewRequest.strict()) {}
// Idempotent atomic commit of a tuned roster (issue #412).
export class EncounterCommitDto extends createZodDto(EncounterCommit.strict()) {}
// .strict() (see CombatantUpdateDto below): an unknown key in an encounter PATCH body
// 400s instead of silently no-op'ing. expectedUpdatedAt (issue #532) added here, not in
// the shared EncounterUpdate — it's a request-time CAS concern, not a stored field (see
// sessions.dto.ts / npcs.dto.ts for the same pattern). Live combat is the highest-contention
// entity (multiple DM devices), so it gets the same optimistic-concurrency invariant as its
// quest/npc/location/session peers.
export class EncounterUpdateDto extends createZodDto(EncounterUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class EncounterEscalationUpdateDto extends createZodDto(EncounterEscalationUpdate.strict()) {}

// .strict() here (not on the shared CombatantCreate/CombatantUpdate exports in
// @campfire/schema — those are reused as-is by mcp-tools.ts and elsewhere, and
// mutating them would ripple well outside this DTO layer): unknown keys in a
// combatant write body 400 instead of silently no-op'ing. This is the concrete
// case that motivated strict-mode: PATCH .../combatants/:cid with a misnamed
// field like `{ hpCurrent: 5 }` (the real column name — CombatantUpdate's actual
// field is `hpSet`/`hpDelta`) previously validated fine (the pipe just stripped
// the unrecognized key) and silently did nothing.
export class CombatantCreateDto extends createZodDto(CombatantCreate.strict()) {}
export class CombatantUpdateDto extends createZodDto(CombatantUpdate.strict()) {}
export class DeathSaveRollDto extends createZodDto(DeathSaveRollRequest.strict()) {}
export class RollRequestDto extends createZodDto(RollRequest.strict()) {}
export class ActionRollRequestDto extends createZodDto(ActionRollRequest.strict()) {}
export class ManualRollRequestDto extends createZodDto(ManualRollRequest.strict()) {}
// Transient battle-map ping (issue #238) — a one-shot SSE broadcast, nothing persisted.
export class MapPingDto extends createZodDto(MapPing.strict()) {}
// Issue #466: reopen may carry per-character HP resync directions when the sheet
// advanced after the previous /end.
export class EncounterReopenDto extends createZodDto(EncounterReopen.strict()) {}
// Issue #413: player/DM end-turn body (optimistic double-advance guard) and
// the per-combatant turn-state declaration patch (action economy, movement, effects, delay/ready).
export class EncounterEndTurnDto extends createZodDto(EncounterEndTurn.strict()) {}
// Issue #580: next-turn gained a body — an `idempotencyKey` (retry dedup) and an
// `expectedCurrentCombatantId` (cross-device CAS). Both fields are optional, because
// next-turn is routinely called with no body at all: the historic bodyless POST, the
// MCP tool, and any `fetch(url, { method: 'POST' })`.
//
// `.default({})` keeps that correct on its own, without depending on
// normalizeMissingBody() (see common/normalize-body.middleware.ts) being registered
// upstream. This is the endpoint that actually broke when the body arrived as
// `undefined`, so it does not delegate its own precondition to global middleware.
export class EncounterNextTurnDto extends createZodDto(EncounterNextTurn.strict().default({})) {}
export class CombatantTurnStatePatchDto extends createZodDto(CombatantTurnStatePatch.strict()) {}
// Issue #414: structured action resolver. Resolve (with optional atomic commit), apply a
// previewed resolution (DM confirm path), and undo an applied resolution. Not .strict() on
// the nested undo token — it echoes a server-produced object with many defaulted fields.
export class ActionResolveRequestDto extends createZodDto(ActionResolveRequest.strict()) {}
// Issue #1451: apply takes a chain-id LOOKUP KEY only, never a client-supplied resolution — see
// ActionResolverService.apply's doc comment for why the prior `ActionResolutionDto` body shape
// was the vulnerability.
export class ActionApplyRequestDto extends createZodDto(ActionApplyRequest.strict()) {}
export class ActionUndoTokenDto extends createZodDto(ActionUndoToken) {}
export class TokenBatchPreviewDto extends createZodDto(TokenBatchPreviewRequest.strict()) {}
export class TokenBatchApplyDto extends createZodDto(TokenBatchApply.strict()) {}
export class TokenBatchUndoDto extends createZodDto(TokenBatchUndo.strict()) {}
export class SavedTokenFormationDto extends createZodDto(SavedTokenFormation.strict()) {}
