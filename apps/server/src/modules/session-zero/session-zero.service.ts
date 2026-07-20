import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
  ) {}

  async get(campaignId: number): Promise<SessionZero> {
    const [row] = await this.db.select().from(sessionZero).where(eq(sessionZero.campaignId, campaignId)).limit(1);
    if (!row) {
      const ts = nowIso();
      return {
        campaignId,
        lines: [],
        veils: [],
        safetyTools: [],
        houseRules: '',
        toneAndExpectations: '',
        createdAt: ts,
        updatedAt: ts,
      };
    }
    return toDomain(row);
  }

  async update(campaignId: number, input: UpdateInput, user: RequestUser, role: Role): Promise<SessionZero> {
    const ts = nowIso();
    const [existing] = await this.db
      .select()
      .from(sessionZero)
      .where(eq(sessionZero.campaignId, campaignId))
      .limit(1);

    let row: typeof sessionZero.$inferSelect;
    if (!existing) {
      [row] = await this.db
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
        .returning();
    } else {
      const patch: Partial<typeof sessionZero.$inferInsert> = { updatedAt: ts };
      if (input.lines !== undefined) patch.lines = toJsonText(input.lines);
      if (input.veils !== undefined) patch.veils = toJsonText(input.veils);
      if (input.safetyTools !== undefined) patch.safetyTools = toJsonText(input.safetyTools);
      if (input.houseRules !== undefined) patch.houseRules = input.houseRules;
      if (input.toneAndExpectations !== undefined) patch.toneAndExpectations = input.toneAndExpectations;
      [row] = await this.db
        .update(sessionZero)
        .set(patch)
        .where(eq(sessionZero.campaignId, campaignId))
        .returning();
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
