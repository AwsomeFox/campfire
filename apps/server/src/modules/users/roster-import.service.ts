import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, count, eq, ne } from 'drizzle-orm';
import type {
  RosterImportCommitResult,
  RosterImportField,
  RosterImportPreview,
  RosterImportRequest,
  RosterImportRow,
  RosterImportRowDiagnostic,
} from '@campfire/schema';
import { User } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignMembers,
  campaigns,
  characters,
  passwordResetRequests,
  users,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { nextUpdatedAt } from '../../common/stale-write';
import { generateResetCode, hashResetCode } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { parseCsv } from './roster-import.csv';
import { UsersService } from './users.service';

type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const DEFAULT_COLUMN_ALIASES: Record<string, RosterImportField> = {
  username: 'username',
  user: 'username',
  login: 'username',
  displayname: 'displayName',
  display_name: 'displayName',
  name: 'displayName',
  oidcsub: 'oidcSub',
  oidc_sub: 'oidcSub',
  sub: 'oidcSub',
  campaignid: 'campaignId',
  campaign_id: 'campaignId',
  campaign: 'campaignId',
  role: 'campaignRole',
  campaignrole: 'campaignRole',
  campaign_role: 'campaignRole',
  characterid: 'characterId',
  character_id: 'characterId',
  character: 'characterId',
};

type ParsedRawRow = {
  rowIndex: number;
  fields: Partial<Record<RosterImportField, string>>;
};

@Injectable()
export class RosterImportService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly usersService: UsersService,
  ) {}

  async run(input: RosterImportRequest, actor: RequestUser): Promise<RosterImportPreview | RosterImportCommitResult> {
    if (input.dryRun) {
      return this.dryRun(input);
    }
    return this.commit(input, actor);
  }

  private dryRun(input: RosterImportRequest): RosterImportPreview {
    const rawRows = this.parseContent(input);
    const diagnostics = this.planRows(rawRows);
    const commitRows = diagnostics
      .filter((row) => row.errors.length === 0 && row.action !== 'error')
      .map((row) => this.toCommitRow(row));
    const batchId = this.computeBatchId(commitRows, input.activationExpiresInDays);
    return {
      dryRun: true,
      batchId,
      totalRows: diagnostics.length,
      validRows: commitRows.length,
      errorRows: diagnostics.filter((row) => row.errors.length > 0).length,
      rows: diagnostics,
      commitRows,
    };
  }

  private async commit(input: RosterImportRequest, actor: RequestUser): Promise<RosterImportCommitResult> {
    if (!input.rows?.length) {
      throw new BadRequestException('Commit requires reviewed rows from a dry-run preview');
    }
    if (!input.batchId) {
      throw new BadRequestException('Commit requires the batchId from the dry-run preview');
    }
    const expectedBatchId = this.computeBatchId(input.rows, input.activationExpiresInDays);
    if (input.batchId !== expectedBatchId) {
      throw new ConflictException('batchId does not match the reviewed rows — re-run dry-run after edits');
    }

    const rowByIndex = new Map<number, RosterImportRow>();
    for (const row of input.rows) {
      if (rowByIndex.has(row.rowIndex)) {
        throw new BadRequestException(`Duplicate rowIndex ${row.rowIndex} in commit batch`);
      }
      rowByIndex.set(row.rowIndex, row);
    }

    const diagnostics = this.planRows(
      input.rows.map((row) => ({
        rowIndex: row.rowIndex,
        fields: this.rowToFields(row),
      })),
    );
    const blocking = diagnostics.filter((row) => row.errors.length > 0);
    if (blocking.length > 0) {
      throw new BadRequestException({
        code: 'ROSTER_IMPORT_VALIDATION_FAILED',
        message: 'One or more rows failed validation — fix the batch or re-run dry-run',
        rows: blocking,
      });
    }

    const ts = nowIso();
    const activationMs = input.activationExpiresInDays * 24 * 60 * 60 * 1000;
    let created = 0;
    let updated = 0;
    let membershipsAdded = 0;
    let membershipsUpdated = 0;
    let skipped = 0;
    const activations: RosterImportCommitResult['activations'] = [];

    this.db.transaction((tx) => {
      for (const diag of diagnostics) {
        const row = rowByIndex.get(diag.rowIndex);
        if (!row) throw new BadRequestException(`Missing reviewed row ${diag.rowIndex}`);

        if (diag.action === 'skip') {
          skipped++;
          continue;
        }

        let userId = diag.matchedUserId ?? null;
        if (diag.action === 'create') {
          if (!row.username) throw new BadRequestException(`Row ${diag.rowIndex} cannot create an account without a username`);
          const inserted = tx
            .insert(users)
            .values({
              username: row.username,
              displayName: row.displayName ?? '',
              passwordHash: null,
              serverRole: 'user',
              disabled: false,
              // Issue #851 — a roster-imported account is not an approved organizer
              // by default (same reasoning as UsersService.create()).
              canCreateCampaigns: false,
              oidcSub: row.oidcSub ?? null,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
            .get();
          userId = inserted.id;
          created++;

          const code = generateResetCode();
          const expiresAt = new Date(Date.now() + activationMs).toISOString();
          tx.insert(passwordResetRequests)
            .values({
              userId: inserted.id,
              status: 'approved',
              codeHash: hashResetCode(code),
              requestedAt: ts,
              approvedAt: ts,
              approvedBy: actor.name,
              expiresAt,
            })
            .run();
          activations.push({
            userId: inserted.id,
            username: inserted.username,
            activationCode: code,
            expiresAt,
          });
        } else if (diag.action === 'update' && userId != null) {
          const existing = tx.select().from(users).where(eq(users.id, userId)).limit(1).get();
          if (!existing) throw new NotFoundException(`User ${userId} not found`);
          const nextDisplay = row.displayName ?? existing.displayName;
          const nextOidcSub = row.oidcSub ?? existing.oidcSub;
          const changed =
            nextDisplay !== existing.displayName ||
            (row.oidcSub !== undefined && nextOidcSub !== existing.oidcSub);
          if (changed) {
            if (nextDisplay !== existing.displayName) {
              this.usersService.synchronizeRosterAttributionTx(
                tx,
                userId,
                existing.displayName || existing.username,
                nextDisplay || existing.username,
              );
            }
            tx.update(users)
              .set({
                displayName: nextDisplay,
                oidcSub: nextOidcSub,
                updatedAt: ts,
              })
              .where(eq(users.id, userId))
              .run();
            updated++;
          } else {
            skipped++;
          }
        }

        if (userId == null) continue;
        if (row.campaignId == null) continue;

        const role = row.campaignRole ?? 'player';
        const membership = this.applyMembershipTx(tx, {
          campaignId: row.campaignId,
          userId,
          role,
          characterId: row.characterId,
          ts,
        });
        if (membership === 'added') membershipsAdded++;
        else if (membership === 'updated') membershipsUpdated++;
        else skipped++;
      }
    });

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: auditActorRole(actor),
      action: 'roster_import.commit',
      entityType: 'user',
      detail: `batch=${input.batchId} created=${created} updated=${updated} membershipsAdded=${membershipsAdded} membershipsUpdated=${membershipsUpdated} skipped=${skipped}`,
    });

    for (const activation of activations) {
      await this.audit.log({
        actor: auditActor(actor),
        actorRole: auditActorRole(actor),
        action: 'user.create',
        entityType: 'user',
        entityId: activation.userId,
        detail: `${activation.username} (roster import; activation issued)`,
      });
    }

    return {
      dryRun: false,
      batchId: input.batchId,
      created,
      updated,
      membershipsAdded,
      membershipsUpdated,
      skipped,
      activations,
    };
  }

  private parseContent(input: RosterImportRequest): ParsedRawRow[] {
    if (input.format === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.content);
      } catch {
        throw new BadRequestException('Invalid JSON content');
      }
      if (!Array.isArray(parsed)) {
        throw new BadRequestException('JSON roster import must be an array of row objects');
      }
      return parsed.map((row, index) => ({
        rowIndex: index,
        fields: this.mapObjectRow(row as Record<string, unknown>, input.columnMap),
      }));
    }

    const table = parseCsv(input.content);
    return table.map((row, index) => ({
      rowIndex: index,
      fields: this.mapCsvRow(row, input.columnMap),
    }));
  }

  private mapCsvRow(
    row: Record<string, string>,
    columnMap: RosterImportRequest['columnMap'],
  ): Partial<Record<RosterImportField, string>> {
    const out: Partial<Record<RosterImportField, string>> = {};
    for (const [header, value] of Object.entries(row)) {
      if (!value) continue;
      const mapped =
        columnMap?.[header] ??
        DEFAULT_COLUMN_ALIASES[header.trim().toLowerCase()] ??
        DEFAULT_COLUMN_ALIASES[header.trim()];
      if (mapped) out[mapped] = value;
    }
    return out;
  }

  private mapObjectRow(
    row: Record<string, unknown>,
    columnMap: RosterImportRequest['columnMap'],
  ): Partial<Record<RosterImportField, string>> {
    const out: Partial<Record<RosterImportField, string>> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value == null || value === '') continue;
      const mapped =
        columnMap?.[key] ??
        DEFAULT_COLUMN_ALIASES[key.trim().toLowerCase()] ??
        (DEFAULT_COLUMN_ALIASES[key.trim()] as RosterImportField | undefined);
      if (mapped) out[mapped] = String(value);
    }
    return out;
  }

  private rowToFields(row: RosterImportRow): Partial<Record<RosterImportField, string>> {
    const fields: Partial<Record<RosterImportField, string>> = {};
    if (row.username !== undefined) fields.username = row.username;
    if (row.displayName !== undefined) fields.displayName = row.displayName;
    if (row.oidcSub !== undefined) fields.oidcSub = row.oidcSub;
    if (row.campaignId !== undefined) fields.campaignId = String(row.campaignId);
    if (row.campaignRole !== undefined) fields.campaignRole = row.campaignRole;
    if (row.characterId !== undefined) fields.characterId = row.characterId == null ? '' : String(row.characterId);
    return fields;
  }

  private planRows(rawRows: ParsedRawRow[]): RosterImportRowDiagnostic[] {
    const seenUsernames = new Map<string, number>();
    const seenOidcSubs = new Map<string, number>();
    const diagnostics: RosterImportRowDiagnostic[] = [];

    for (const raw of rawRows) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const username = raw.fields.username?.trim();
      const oidcSub = raw.fields.oidcSub?.trim();
      const displayName = raw.fields.displayName?.trim();
      const campaignId = this.parseOptionalInt(raw.fields.campaignId);
      const campaignRole = raw.fields.campaignRole?.trim() as RosterImportRow['campaignRole'] | undefined;
      const characterId = this.parseNullableInt(raw.fields.characterId);

      if (!username && !oidcSub) {
        errors.push('Row needs at least one of username or oidcSub');
      }
      if (username) {
        const parsed = User.shape.username.safeParse(username);
        if (!parsed.success) errors.push(parsed.error.issues[0]?.message ?? 'Invalid username');
        const prior = seenUsernames.get(username.toLowerCase());
        if (prior !== undefined) errors.push(`Duplicate username in batch (also on row ${prior})`);
        else seenUsernames.set(username.toLowerCase(), raw.rowIndex);
      }
      if (oidcSub) {
        const prior = seenOidcSubs.get(oidcSub);
        if (prior !== undefined) errors.push(`Duplicate oidcSub in batch (also on row ${prior})`);
        else seenOidcSubs.set(oidcSub, raw.rowIndex);
      }
      if (campaignId != null) {
        const campaign = this.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1).get();
        if (!campaign) errors.push(`Campaign ${campaignId} does not exist`);
      } else if (campaignRole || characterId != null) {
        errors.push('campaignId is required when assigning a role or character');
      }
      if (campaignRole && !['dm', 'player', 'viewer'].includes(campaignRole)) {
        errors.push(`Invalid campaign role "${campaignRole}"`);
      }
      if (characterId != null && campaignId != null) {
        const character = this.db
          .select({ id: characters.id })
          .from(characters)
          .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
          .limit(1)
          .get();
        if (!character) errors.push(`characterId ${characterId} does not exist in campaign ${campaignId}`);
      }

      let matchedUserId: number | null = null;
      let matchBy: 'username' | 'oidcSub' | null = null;
      const byOidc = oidcSub ? this.db.select().from(users).where(eq(users.oidcSub, oidcSub)).limit(1).get() : null;
      const byUsername = username ? this.db.select().from(users).where(eq(users.username, username)).limit(1).get() : null;
      if (byOidc && byUsername && byOidc.id !== byUsername.id) {
        errors.push('username and oidcSub match different existing accounts');
      } else if (byOidc) {
        matchedUserId = byOidc.id;
        matchBy = 'oidcSub';
      } else if (byUsername) {
        matchedUserId = byUsername.id;
        matchBy = 'username';
      }

      let action: RosterImportRowDiagnostic['action'] = 'error';
      if (errors.length === 0) {
        if (matchedUserId != null) {
          action = 'update';
          const matchedDisabled = byUsername?.disabled || byOidc?.disabled;
          if (matchedDisabled) {
            if (campaignId != null) {
              errors.push('Matched account is disabled — enable it before assigning campaign membership');
              action = 'error';
            } else {
              warnings.push('Matched account is disabled');
            }
          }
        } else if (username) {
          action = 'create';
        } else {
          errors.push('Cannot create a new account without a username');
          action = 'error';
        }

        if (matchedUserId != null && campaignId != null) {
          const existing = this.db
            .select({ id: campaignMembers.id, role: campaignMembers.role, characterId: campaignMembers.characterId })
            .from(campaignMembers)
            .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, matchedUserId)))
            .limit(1)
            .get();
          const desiredRole = campaignRole ?? 'player';
          const matchedUser = byUsername ?? byOidc;
          const displayNameMatches = !displayName || displayName === matchedUser?.displayName;
          if (
            existing &&
            existing.role === desiredRole &&
            (characterId === undefined || existing.characterId === characterId) &&
            displayNameMatches
          ) {
            action = 'skip';
            warnings.push('Membership already matches — row is a no-op');
          }
        }
      }

      if (matchedUserId != null && campaignId != null) {
        const desiredRole = campaignRole ?? 'player';
        if (desiredRole !== 'dm') {
          const member = this.db
            .select({ role: campaignMembers.role })
            .from(campaignMembers)
            .innerJoin(users, eq(campaignMembers.userId, users.id))
            .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, matchedUserId)))
            .limit(1)
            .get();
          if (member?.role === 'dm' && this.usableDmCount(campaignId, matchedUserId) === 0) {
            errors.push('Cannot demote the last enabled dm of this campaign');
            action = 'error';
          }
        }
      }

      diagnostics.push({
        rowIndex: raw.rowIndex,
        action,
        matchedUserId,
        matchBy,
        username: username ?? undefined,
        displayName: displayName ?? undefined,
        oidcSub: oidcSub ?? undefined,
        campaignId: campaignId ?? undefined,
        campaignRole: campaignRole ?? (campaignId != null ? 'player' : undefined),
        characterId: characterId ?? undefined,
        errors,
        warnings,
      });
    }

    return diagnostics;
  }

  private toCommitRow(diag: RosterImportRowDiagnostic): RosterImportRow {
    if (!diag.username && !diag.oidcSub) {
      throw new BadRequestException(`Row ${diag.rowIndex} is missing a username and oidcSub`);
    }
    return {
      rowIndex: diag.rowIndex,
      username: diag.username,
      displayName: diag.displayName,
      oidcSub: diag.oidcSub,
      campaignId: diag.campaignId,
      campaignRole: diag.campaignRole,
      characterId: diag.characterId,
    };
  }

  private computeBatchId(rows: RosterImportRow[], activationExpiresInDays: number): string {
    const canonical = JSON.stringify({ rows, activationExpiresInDays });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private parseOptionalInt(value: string | undefined): number | null {
    if (value == null || value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  private parseNullableInt(value: string | undefined): number | null | undefined {
    if (value === undefined) return undefined;
    if (value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  private usableDmCount(campaignId: number, excludeUserId?: number): number {
    const conditions = [
      eq(campaignMembers.campaignId, campaignId),
      eq(campaignMembers.role, 'dm'),
      eq(users.disabled, false),
    ];
    if (excludeUserId !== undefined) conditions.push(ne(campaignMembers.userId, excludeUserId));
    return (
      this.db
        .select({ value: count() })
        .from(campaignMembers)
        .innerJoin(users, eq(campaignMembers.userId, users.id))
        .where(and(...conditions))
        .get()?.value ?? 0
    );
  }

  private applyMembershipTx(
    tx: SyncDb,
    input: {
      campaignId: number;
      userId: number;
      role: 'dm' | 'player' | 'viewer';
      characterId: number | null | undefined;
      ts: string;
    },
  ): 'added' | 'updated' | 'skipped' {
    const user = tx.select().from(users).where(eq(users.id, input.userId)).limit(1).get();
    if (!user) throw new NotFoundException(`User ${input.userId} not found`);
    if (user.disabled) throw new BadRequestException(`User ${input.userId} is disabled`);

    const existing = tx
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, input.campaignId), eq(campaignMembers.userId, input.userId)))
      .limit(1)
      .get();

    if (existing) {
      const demotingUsableDm =
        input.role !== 'dm' &&
        existing.role === 'dm' &&
        !user.disabled &&
        this.usableDmCountTx(tx, input.campaignId, input.userId) === 0;
      if (demotingUsableDm) {
        throw new ConflictException('Cannot demote the last dm of this campaign');
      }
      const sameRole = existing.role === input.role;
      const sameCharacter = input.characterId === undefined || existing.characterId === input.characterId;
      if (sameRole && sameCharacter) return 'skipped';
      tx.update(campaignMembers)
        .set({
          role: input.role,
          characterId: input.characterId ?? existing.characterId,
          updatedAt: input.ts,
        })
        .where(eq(campaignMembers.id, existing.id))
        .run();
      if (input.characterId != null) {
        // Issue #1902 rework (round 15, codex P2 sweep): PER CHARACTER, not the batch-wide
        // `input.ts` (computed ONCE for the whole roster import — every row linking a
        // DIFFERENT character would otherwise share one timestamp, the same class of bug
        // as `restParty`'s original defect, just spread across one-row-at-a-time writes
        // instead of a single bulk statement).
        const current = tx.select({ updatedAt: characters.updatedAt }).from(characters).where(eq(characters.id, input.characterId)).get();
        tx.update(characters)
          .set({ ownerUserId: String(input.userId), updatedAt: nextUpdatedAt(current?.updatedAt ?? input.ts) })
          .where(eq(characters.id, input.characterId))
          .run();
      }
      return 'updated';
    }

    tx.insert(campaignMembers)
      .values({
        campaignId: input.campaignId,
        userId: input.userId,
        role: input.role,
        characterId: input.characterId ?? null,
        createdAt: input.ts,
        updatedAt: input.ts,
      })
      .run();
    if (input.characterId != null) {
      const current = tx.select({ updatedAt: characters.updatedAt }).from(characters).where(eq(characters.id, input.characterId)).get();
      tx.update(characters)
        .set({ ownerUserId: String(input.userId), updatedAt: nextUpdatedAt(current?.updatedAt ?? input.ts) })
        .where(eq(characters.id, input.characterId))
        .run();
    }
    return 'added';
  }

  private usableDmCountTx(tx: SyncDb, campaignId: number, excludeUserId?: number): number {
    const conditions = [
      eq(campaignMembers.campaignId, campaignId),
      eq(campaignMembers.role, 'dm'),
      eq(users.disabled, false),
    ];
    if (excludeUserId !== undefined) conditions.push(ne(campaignMembers.userId, excludeUserId));
    return (
      tx
        .select({ value: count() })
        .from(campaignMembers)
        .innerJoin(users, eq(campaignMembers.userId, users.id))
        .where(and(...conditions))
        .get()?.value ?? 0
    );
  }
}
