import { createZodDto } from 'nestjs-zod';
import { EncounterCreate, EncounterGenerate, EncounterPreviewRequest, EncounterCommit, EncounterUpdate, EncounterEscalationUpdate, EncounterReopen, CombatantCreate, CombatantUpdate, CombatantRemoveRequest, CombatantRemoveUndo, CombatantResourceAdjust, CombatantStatblock, CreatureCheckRollRequest, DeathSaveRollRequest, CombatantRollInitiativeRequest, CombatantReorderRequest, CombatantTurnStatePatch, EncounterEndTurn, EncounterNextTurn, RollRequest, ActionRollRequest, ManualRollRequest, MapObjectCreate, MapObjectUpdate, MapPing, ExpectedUpdatedAt, ActionResolveRequest, ActionApplyRequest, ActionUndoToken, TokenBatchPreviewRequest, TokenBatchApply, TokenBatchUndo, SavedTokenFormation, QuickRollRequest, EncounterAftermathApplyXpInput, EncounterAftermathLootTransferInput, EncounterAftermathQuestUpdateInput, EncounterAftermathBeatUpdateInput, EncounterAftermathTimelineEventInput, AoeTemplateDeclare, AoeTemplateUpdate } from '@campfire/schema';

export class EncounterCreateDto extends createZodDto(EncounterCreate.strict()) {}
export class QuickRollRequestDto extends createZodDto(QuickRollRequest.strict()) {}
export class CreatureCheckRollDto extends createZodDto(CreatureCheckRollRequest.strict()) {}

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
// expectedStatblock (issue #1992) is a SEPARATE, additive CAS field, for the `statblock`
// field only — deliberately not a repurposing of expectedUpdatedAt, whose meaning (the
// ENCOUNTER's own revision) is unchanged for every other caller. It rejects a `statblock`
// write with 409 only when the row's CURRENTLY STORED statblock no longer content-equals
// what the caller says it started from (encounters.service.ts's updateCombatant,
// deepJsonEqual). An earlier round tried a per-combatant REVISION token
// (`expectedCombatantUpdatedAt`, bumped on every write to the row) and found it still too
// coarse: an hp/condition/position change to the SAME combatant advances a row-revision
// token without touching the statblock, so it would falsely 409 an unrelated in-progress
// edit. That field was removed entirely (never shipped a client, no reader anywhere) once
// the content-based guard proved to be the field's only real consumer — see PR #2027's
// history for the full trace.
export class CombatantUpdateDto extends createZodDto(
  CombatantUpdate.extend({
    expectedUpdatedAt: ExpectedUpdatedAt,
    expectedStatblock: CombatantStatblock.optional(),
  }).strict(),
) {}
// Issue #1909: already `.strict()` + refined (exactly one of key|spellLevel) in the shared
// schema itself — not re-applied here, matching ConditionLevelPatchDto's own pattern, since
// `.strict()` is a ZodObject method that no longer exists once `.superRefine()` has wrapped
// it in a ZodEffects.
export class CombatantResourceAdjustDto extends createZodDto(CombatantResourceAdjust) {}
export class CombatantRemoveRequestDto extends createZodDto(CombatantRemoveRequest.strict().default({})) {}
export class DeathSaveRollDto extends createZodDto(DeathSaveRollRequest.strict()) {}
export class CombatantRollInitiativeDto extends createZodDto(CombatantRollInitiativeRequest.strict()) {}
// Issue #1923: DM-only manual reorder. .strict() so an unknown key 400s rather than
// silently no-op'ing, matching every other combatant write body in this file.
export class CombatantReorderDto extends createZodDto(CombatantReorderRequest.strict()) {}
export class CombatantRemoveUndoDto extends createZodDto(CombatantRemoveUndo.strict()) {}
export class RollRequestDto extends createZodDto(RollRequest.strict()) {}
export class ActionRollRequestDto extends createZodDto(ActionRollRequest.strict()) {}
export class ManualRollRequestDto extends createZodDto(ManualRollRequest.strict()) {}
// Transient battle-map ping (issue #238) — a one-shot SSE broadcast, nothing persisted.
export class MapPingDto extends createZodDto(MapPing.strict()) {}
// Player AoE routes deliberately use shapes that exclude `declaredByUserId` (#1913):
// attribution is stamped from the authenticated request inside EncountersService.
export class AoeTemplateDeclareDto extends createZodDto(AoeTemplateDeclare) {}
export class AoeTemplateUpdateDto extends createZodDto(AoeTemplateUpdate) {}
// Persistent map icons/set pieces (issue #1308) — DM-only, so unlike AoE there is no
// attribution field to exclude. Both shapes are already `.strict()` at their schema
// definition (see @campfire/schema), matching AoeTemplateDeclare/AoeTemplateUpdate's own
// convention of not re-applying `.strict()` here.
export class MapObjectCreateDto extends createZodDto(MapObjectCreate) {}
export class MapObjectUpdateDto extends createZodDto(MapObjectUpdate) {}
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

// Issue #1448: Encounter aftermath mutation DTOs
export class EncounterAftermathApplyXpInputDto extends createZodDto(EncounterAftermathApplyXpInput.strict().default({})) {}
export class EncounterAftermathLootTransferInputDto extends createZodDto(EncounterAftermathLootTransferInput.strict().default({})) {}
export class EncounterAftermathQuestUpdateInputDto extends createZodDto(EncounterAftermathQuestUpdateInput.strict()) {}
export class EncounterAftermathBeatUpdateInputDto extends createZodDto(EncounterAftermathBeatUpdateInput.strict().default({})) {}
export class EncounterAftermathTimelineEventInputDto extends createZodDto(EncounterAftermathTimelineEventInput.strict()) {}
