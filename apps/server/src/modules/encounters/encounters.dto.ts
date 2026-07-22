import { createZodDto } from 'nestjs-zod';
import { EncounterCreate, EncounterGenerate, EncounterUpdate, CombatantCreate, CombatantUpdate, RollRequest, MapPing, ExpectedUpdatedAt } from '@campfire/schema';

export class EncounterCreateDto extends createZodDto(EncounterCreate.strict()) {}
// Encounter generator request (issue #304). .strict() so an unknown/misspelled key 400s
// rather than being silently dropped, consistent with the other encounter write bodies.
export class EncounterGenerateDto extends createZodDto(EncounterGenerate.strict()) {}
// .strict() (see CombatantUpdateDto below): an unknown key in an encounter PATCH body
// 400s instead of silently no-op'ing. expectedUpdatedAt (issue #532) added here, not in
// the shared EncounterUpdate — it's a request-time CAS concern, not a stored field (see
// sessions.dto.ts / npcs.dto.ts for the same pattern). Live combat is the highest-contention
// entity (multiple DM devices), so it gets the same optimistic-concurrency invariant as its
// quest/npc/location/session peers.
export class EncounterUpdateDto extends createZodDto(EncounterUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}

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
export class RollRequestDto extends createZodDto(RollRequest.strict()) {}
// Transient battle-map ping (issue #238) — a one-shot SSE broadcast, nothing persisted.
export class MapPingDto extends createZodDto(MapPing.strict()) {}
