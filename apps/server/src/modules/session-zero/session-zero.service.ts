import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { SessionZeroUpdate } from '@campfire/schema';
import type { SessionZero, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { sessionZero } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { MISSING_REVISION, nextUpdatedAt, staleWrite } from '../../common/stale-write';
import { RevisionsService } from '../revisions/revisions.service';

type UpdateInput = z.infer<typeof SessionZeroUpdate>;

function toDomain(row: typeof sessionZero.$inferSelect): SessionZero {
  return {
    campaignId: row.campaignId,
    lines: fromJsonText<string[]>(row.lines, []),
    veils: fromJsonText<string[]>(row.veils, []),
    safetyTools: fromJsonText<string[]>(row.safetyTools, []),
    houseRules: row.houseRules,
    toneAndExpectations: row.toneAndExpectations,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Session zero / table charter (issue #122).
 *
 * A single "shared table memory" row per campaign holding lines & veils, the safety
 * tools the table agreed to use, house rules, and tone/content expectations. It's the
 * same single-row-per-campaign upsert shape as the timeline calendar: the charter is
 * member-readable and carries no dmSecret (a safety record every player must be able to
 * see), so there is no redaction. A campaign that has never run session zero reads as an
 * empty default rather than 404 — the page always has a charter to render and edit.
 */
@Injectable()
export class SessionZeroService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly revisions: RevisionsService,
  ) {}

  async get(campaignId: number): Promise<SessionZero> {
    const [row] = await this.db.select().from(sessionZero).where(eq(sessionZero.campaignId, campaignId)).limit(1);
    if (!row) {
      return {
        campaignId,
        lines: [],
        veils: [],
        safetyTools: [],
        houseRules: '',
        toneAndExpectations: '',
        createdAt: MISSING_REVISION,
        updatedAt: MISSING_REVISION,
      };
    }
    return toDomain(row);
  }

  async update(
    campaignId: number,
    input: UpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<SessionZero> {
    const [existing] = await this.db
      .select()
      .from(sessionZero)
      .where(eq(sessionZero.campaignId, campaignId))
      .limit(1);

    let row: typeof sessionZero.$inferSelect;
    if (!existing) {
      if (opts?.expectedUpdatedAt && opts.expectedUpdatedAt !== MISSING_REVISION) {
        throw staleWrite(opts.expectedUpdatedAt, MISSING_REVISION);
      }
      const ts = nowIso();
      const inserted = await this.db
        .insert(sessionZero)
        .values({
          campaignId,
          lines: toJsonText(input.lines ?? []),
          veils: toJsonText(input.veils ?? []),
          safetyTools: toJsonText(input.safetyTools ?? []),
          houseRules: input.houseRules ?? '',
          toneAndExpectations: input.toneAndExpectations ?? '',
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted[0]) {
        const current = await this.get(campaignId);
        throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
      }
      row = inserted[0];
    } else {
      const patch: Partial<typeof sessionZero.$inferInsert> = { updatedAt: nextUpdatedAt(existing.updatedAt) };
      if (input.lines !== undefined) patch.lines = toJsonText(input.lines);
      if (input.veils !== undefined) patch.veils = toJsonText(input.veils);
      if (input.safetyTools !== undefined) patch.safetyTools = toJsonText(input.safetyTools);
      if (input.houseRules !== undefined) patch.houseRules = input.houseRules;
      if (input.toneAndExpectations !== undefined) patch.toneAndExpectations = input.toneAndExpectations;
      const updated = await this.db
        .update(sessionZero)
        .set(patch)
        .where(
          opts?.expectedUpdatedAt
            ? and(eq(sessionZero.campaignId, campaignId), eq(sessionZero.updatedAt, opts.expectedUpdatedAt))
            : eq(sessionZero.campaignId, campaignId),
        )
        .returning();
      if (!updated[0]) {
        const current = await this.get(campaignId);
        throw staleWrite(opts?.expectedUpdatedAt, current.updatedAt);
      }
      row = updated[0];
      const before = toDomain(existing);
      const after = toDomain(row);
      if (
        JSON.stringify(before.lines) !== JSON.stringify(after.lines) ||
        JSON.stringify(before.veils) !== JSON.stringify(after.veils) ||
        JSON.stringify(before.safetyTools) !== JSON.stringify(after.safetyTools) ||
        before.houseRules !== after.houseRules ||
        before.toneAndExpectations !== after.toneAndExpectations
      ) {
        await this.revisions.recordSnapshot({
          entityType: 'session_zero',
          entityId: campaignId,
          campaignId,
          snapshot: {
            lines: before.lines,
            veils: before.veils,
            safetyTools: before.safetyTools,
            houseRules: before.houseRules,
            toneAndExpectations: before.toneAndExpectations,
          },
          user,
        });
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session_zero.update',
      entityType: 'session_zero',
      entityId: campaignId,
      campaignId,
    });
    return toDomain(row);
  }
}
