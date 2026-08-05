import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type {
  CastSafetyState,
  CastSession,
  CastSessionCreate,
  CastSessionCreated,
  CastSessionMutationResult,
  CampaignSummary,
  Encounter,
  EncounterWithCombatants,
  Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, castSessions, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import {
  castTokenPrefix,
  generateCastExitPin,
  generateCastToken,
  hashCastToken,
  hashPassword,
  looksLikeCastToken,
  verifyPassword,
} from '../../common/crypto';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { parseFogState } from '../../common/fog';
import { AuditService } from '../audit/audit.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { EncountersService } from '../encounters/encounters.service';
import { EncounterMapService, type EncounterMapView } from '../encounters/encounter-map.service';
import { TableSafetyService } from '../safety/table-safety.service';

const CAST_VIEWER_ROLE: Role = 'viewer';
// A cast link is an anonymous player-safe projection, never a party-sheet credential.
const CAST_VIEWER_USER: RequestUser = { id: 'cast:viewer', name: 'Cast viewer', serverRole: 'user' };
const UNIFORM_NOT_FOUND = 'Cast session not found or expired';
const DUMMY_CAST_TOKEN = `cf_cast_${'0'.repeat(48)}`;

/**
 * Hard ceiling on a cast credential's lifetime. Issue #547 asks for
 * "one-time/expiring" credentials; without a cap, a client (or a hand-rolled
 * API call) could mint a cast URL valid for years, which is indistinguishable
 * from a permanent public link to the campaign's player-safe projection.
 */
const MAX_CAST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function toDomain(row: typeof castSessions.$inferSelect): CastSession {
  return {
    id: row.id,
    campaignId: row.campaignId,
    label: row.label,
    createdBy: row.createdBy,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt,
    accessCount: row.accessCount,
    firstAccessedAt: row.firstAccessedAt,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeFutureExpiry(expiresAt: string): string {
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  if (timestamp - Date.now() > MAX_CAST_TTL_MS) {
    throw new BadRequestException('expiresAt must be within 30 days');
  }
  return new Date(timestamp).toISOString();
}

@Injectable()
export class CastService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly campaignsService: CampaignsService,
    private readonly encountersService: EncountersService,
    private readonly encounterMaps: EncounterMapService,
    private readonly tableSafety: TableSafetyService,
  ) {}

  async listForCampaign(campaignId: number): Promise<CastSession[]> {
    const ts = nowIso();
    const rows = await this.db
      .select()
      .from(castSessions)
      .where(and(eq(castSessions.campaignId, campaignId), gt(castSessions.expiresAt, ts)))
      .orderBy(desc(castSessions.id));
    return rows.map(toDomain);
  }

  async create(campaignId: number, input: CastSessionCreate, user: RequestUser, role: Role): Promise<CastSessionCreated> {
    const expiresAt = normalizeFutureExpiry(input.expiresAt);
    const token = generateCastToken();
    const exitPin = generateCastExitPin();
    const ts = nowIso();

    const row = this.db.transaction((tx) => {
      const accountId = Number(user.id);
      const current = Number.isInteger(accountId) && accountId > 0
        ? tx.select({ displayName: users.displayName, username: users.username }).from(users).where(eq(users.id, accountId)).limit(1).get()
        : undefined;
      const createdBy = current ? (current.displayName || current.username) : (Number.isInteger(accountId) && accountId > 0 ? 'Deleted user' : user.name);
      const campaign = tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), notDeleted(campaigns.deletedAt)))
        .limit(1)
        .get();
      if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
      if (campaign.status !== 'active') {
        throw new ForbiddenException('Cast sessions require an active campaign');
      }
      return tx
        .insert(castSessions)
        .values({
          campaignId,
          label: input.label,
          createdBy,
          createdByUserId: user.id,
          tokenHash: hashCastToken(token),
          tokenPrefix: castTokenPrefix(token),
          exitPinHash: hashPassword(exitPin),
          expiresAt,
          accessCount: 0,
          firstAccessedAt: null,
          lastAccessedAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.cast.create',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify({ label: row.label, expiresAt: row.expiresAt, tokenPrefix: row.tokenPrefix }),
    });

    return { token, exitPin, url: `/cast/${campaignId}/${token}`, session: toDomain(row) };
  }

  async revoke(campaignId: number, castSessionId: number, user: RequestUser, role: Role): Promise<void> {
    const [row] = await this.db
      .select()
      .from(castSessions)
      .where(and(eq(castSessions.id, castSessionId), eq(castSessions.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Cast session ${castSessionId} not found for this campaign`);
    await this.db.delete(castSessions).where(eq(castSessions.id, castSessionId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.cast.revoke',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: row.tokenPrefix,
    });
  }

  async revokeAll(campaignId: number, user: RequestUser, role: Role): Promise<CastSessionMutationResult> {
    const deleted = await this.db
      .delete(castSessions)
      .where(eq(castSessions.campaignId, campaignId))
      .returning({ id: castSessions.id });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.cast.revoke_all',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify({ revoked: deleted.length }),
    });
    return { revoked: deleted.length };
  }

  private resolveActive(token: string): typeof castSessions.$inferSelect {
    const tokenToHash = looksLikeCastToken(token) ? token : DUMMY_CAST_TOKEN;
    const row = this.db
      .select()
      .from(castSessions)
      .where(eq(castSessions.tokenHash, hashCastToken(tokenToHash)))
      .limit(1)
      .get();
    const ts = nowIso();
    if (!looksLikeCastToken(token) || !row || row.expiresAt <= ts) {
      throw new NotFoundException(UNIFORM_NOT_FOUND);
    }

    const campaign = this.db
      .select({ status: campaigns.status, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(eq(campaigns.id, row.campaignId))
      .limit(1)
      .get();
    if (!campaign || campaign.deletedAt !== null || campaign.status !== 'active') {
      throw new NotFoundException(UNIFORM_NOT_FOUND);
    }

    // Do the read-modify-write entirely in SQL: two concurrent cast polls must not
    // both observe firstAccessedAt = NULL and race a later timestamp into the column.
    // RETURNING gives us the row the DB actually committed, so the value we hand back
    // can never diverge from storage (Copilot review on #1438).
    const updated = this.db
      .update(castSessions)
      .set({
        accessCount: sql`${castSessions.accessCount} + 1`,
        firstAccessedAt: sql`coalesce(${castSessions.firstAccessedAt}, ${ts})`,
        lastAccessedAt: ts,
        updatedAt: ts,
      })
      .where(eq(castSessions.id, row.id))
      .returning()
      .get();
    return updated ?? row;
  }

  async summary(token: string): Promise<CampaignSummary> {
    const cast = this.resolveActive(token);
    return this.campaignsService.summary(cast.campaignId, CAST_VIEWER_USER, CAST_VIEWER_ROLE);
  }

  async runningEncounters(token: string): Promise<Encounter[]> {
    const cast = this.resolveActive(token);
    return this.encountersService.listForCampaign(cast.campaignId, 'running', CAST_VIEWER_ROLE);
  }

  /**
   * Server-authorized projection used by the authenticated Player Display preview.
   *
   * The preview is opened from a DM session, but it is still a table-facing
   * surface. Its payload must therefore have the same viewer authority as an
   * anonymous cast capability before it crosses the API boundary.
   */
  async playerDisplaySummary(campaignId: number): Promise<CampaignSummary> {
    return this.campaignsService.summary(campaignId, CAST_VIEWER_USER, CAST_VIEWER_ROLE);
  }

  async playerDisplayRunningEncounters(campaignId: number): Promise<Encounter[]> {
    return this.encountersService.listForCampaign(campaignId, 'running', CAST_VIEWER_ROLE);
  }

  /**
   * Read-only X-Card state for the cast display (issue #1908).
   *
   * The shared TV has no member identity, so it cannot call the member-facing
   * `GET /campaigns/:id/safety` (`TableSafetyController.get`, which requires membership).
   * This projects `TableSafetyService.getHold()` down to the one field every gate
   * reads — no actor, name, note, or timestamp ever reaches an anonymous capability.
   *
   * Uses `resolveActive`, the same uniform-404 + access-bookkeeping path every other
   * cast route uses. That does mean a 5s poll bumps `access_count` on every tick (the
   * same double-count caution as the #1438 review on the encounters list) — acceptable
   * here because the safety poll is the only signal a cast client has for this state.
   */
  safety(token: string): CastSafetyState {
    const cast = this.resolveActive(token);
    return { active: this.tableSafety.getHold(cast.campaignId).active };
  }

  /**
   * Validate a cast capability without projecting any campaign data.
   *
   * The encounter LIST endpoint answers only `status=running`, but it must still 404 an
   * invalid/expired/revoked capability for any other status rather than returning an empty
   * list — otherwise a stale shared-TV link is told its request succeeded, contradicting
   * the uniform not-found contract every other cast endpoint (and that endpoint's own
   * docstring) promises. Devin review on #1438.
   */
  assertActive(token: string): void {
    this.resolveActive(token);
  }

  /**
   * Resolve an encounter row a cast capability is allowed to read. Mirrors the
   * running-only contract the cast LIST endpoint enforces: the Player Display only
   * ever shows the live fight, so a cast URL must not be able to pull rosters for
   * still-being-prepped or already-ended encounters by id (Devin review on #1438).
   */
  private async castEncounterRowOrThrow(cast: typeof castSessions.$inferSelect, encounterId: number) {
    const row = await this.encountersService.getRowOrThrow(encounterId);
    if (row.campaignId !== cast.campaignId || row.status !== 'running') {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    return row;
  }

  async encounter(token: string, encounterId: number): Promise<EncounterWithCombatants> {
    const cast = this.resolveActive(token);
    await this.castEncounterRowOrThrow(cast, encounterId);
    return this.playerDisplayEncounterProjection(encounterId);
  }

  /**
   * Authenticated previews deliberately share the cast endpoint's running-only
   * scope. Callers must establish campaign membership before invoking this;
   * this method owns the viewer-role projection itself.
   */
  async playerDisplayEncounter(campaignId: number, encounterId: number): Promise<EncounterWithCombatants> {
    const row = await this.encountersService.getRowOrThrow(encounterId);
    if (row.campaignId !== campaignId || row.status !== 'running') {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    return this.playerDisplayEncounterProjection(encounterId);
  }

  /** Viewer-safe map bytes for the authenticated Player Display preview. */
  async playerDisplayEncounterMap(
    campaignId: number,
    encounterId: number,
    variant: 'original' | 'thumb',
  ): Promise<EncounterMapView> {
    const row = await this.encountersService.getRowOrThrow(encounterId);
    if (row.campaignId !== campaignId || row.status !== 'running') {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const encounter = this.encountersService.encounterForMapOrThrow(row, CAST_VIEWER_ROLE);
    const persistedFogInvalid = row.fog !== null && parseFogState(row.fog) === null;
    return this.encounterMaps.resolve(encounter, CAST_VIEWER_ROLE, variant, persistedFogInvalid);
  }

  /**
   * `getWithCombatantsOrThrow(..., 'viewer')` owns HP, fog, hidden-entity, and
   * AoE redaction. The Player Display also never needs a combat turn workspace
   * or death-save counters, so replace those sensitive fields server-side before
   * either authenticated or capability clients receive the encounter.
   */
  private async playerDisplayEncounterProjection(encounterId: number): Promise<EncounterWithCombatants> {
    const encounter = await this.encountersService.getWithCombatantsOrThrow(encounterId, CAST_VIEWER_ROLE);
    return {
      ...encounter,
      combatants: encounter.combatants.map((combatant) => ({
        ...combatant,
        deathSaveSuccesses: 0,
        deathSaveFailures: 0,
        turnState: {
          used: {},
          movementUsedFt: 0,
          concentration: null,
          pendingConcentrationChecks: [],
          delaying: false,
          readied: null,
        },
      })),
    };
  }

  /**
   * Battle-map pixels for the cast display.
   *
   * Without this the cast page's <img> would have to point at
   * GET /encounters/:id/map, which authenticates from the session COOKIE. On the
   * exact device issue #547 is about — a shared TV that still holds the DM's
   * cookie — that request resolves as role `dm` and hands the TV the *unfogged
   * source map*. Serving the bytes through the capability instead pins the role to
   * `viewer`, so the fog renderer always runs and the source attachment is never
   * reachable from a cast client.
   */
  async encounterMap(token: string, encounterId: number, variant: 'original' | 'thumb'): Promise<EncounterMapView> {
    const cast = this.resolveActive(token);
    const row = await this.castEncounterRowOrThrow(cast, encounterId);
    const encounter = this.encountersService.encounterForMapOrThrow(row, CAST_VIEWER_ROLE);
    // Same fail-closed rule as the authenticated map route: a non-null but
    // unparsable fog blob renders an all-concealed view rather than the source.
    const persistedFogInvalid = row.fog !== null && parseFogState(row.fog) === null;
    return this.encounterMaps.resolve(encounter, CAST_VIEWER_ROLE, variant, persistedFogInvalid);
  }

  async verifyExitPin(token: string, pin: string): Promise<{ ok: true }> {
    const cast = this.resolveActive(token);
    if (!verifyPassword(pin, cast.exitPinHash)) {
      throw new ForbiddenException('Invalid cast exit PIN');
    }
    return { ok: true };
  }
}
