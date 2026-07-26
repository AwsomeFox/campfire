import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { AttachmentDerivative, AttachmentDerivativeManifest, DerivativeState } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachmentDerivatives, attachments } from '../../db/schema';
import { nowIso } from '../../common/time';
import { ATTACHMENT_STATE_COMMITTED } from './attachment.constants';
import { attachmentFilePath, derivativeFilePath, STAGE_SUFFIX } from './attachment-paths';
import {
  DERIVATIVE_LADDER,
  DERIVATIVE_MIME,
  ImageLimitError,
  isDerivableMime,
  probeImageWithinLimits,
  renderDerivative,
  shouldMaterialise,
  type DerivativeVariantName,
} from './image-derivatives';

/**
 * Durable, asynchronous derivative generation for image attachments (issue #604).
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * `?size=thumb` used to call a hand-rolled PNG decoder INSIDE the request
 * handler. Two bad consequences: (a) the first viewer of a large map paid a
 * full-pixel inflate on the event loop, and (b) any format outside that
 * decoder's narrow subset (JPEG, WebP, SVG, palette/16-bit/interlaced PNG)
 * produced no thumbnail at all, so the response fell back to streaming the
 * multi-MB ORIGINAL — which is what made world/encounter maps slow for
 * everyone, on every load, forever.
 *
 * THE MODEL
 * ---------
 * One `attachment_derivatives` row per (attachment, ladder rung):
 *
 *   pending  — planned, not yet generated. The work item for the drain.
 *   ready    — bytes exist on disk and may be served.
 *   failed   — generation raised; `attempts`/`last_error` explain why. Retried
 *              automatically up to DERIVATIVE_MAX_ATTEMPTS, then only on an
 *              explicit DM retry (POST /attachments/:id/derivatives/retry).
 *   skipped  — the source is already at/below this rung, so materialising it
 *              would waste disk for zero byte saving. Serving falls back to a
 *              smaller ready rung, or to the original (documented last resort).
 *
 * Rows are DURABLE, so a restart mid-generation resumes rather than restarting
 * from scratch, and a served derivative is never regenerated per request.
 *
 * WHY THIS BACKGROUND SHAPE
 * -------------------------
 * It is the same shape FsDeletionService (#727) already uses in this module:
 * a table of work items, a drain on `onApplicationBootstrap`, an `.unref()`d
 * `setInterval` retry, and a `drainInFlight` promise so boot/interval/kick
 * passes cannot overlap. Deliberately NOT a worker thread or an external queue:
 * Campfire is a single-process self-hosted server, and one image at a time with
 * a bounded batch is the behaviour an operator can reason about (see
 * website/docs/administration/server.md).
 *
 * FITTING THE RESERVATION/PUBLICATION MODEL
 * -----------------------------------------
 * Derivatives are planned only for `committed` attachments, so an interrupted
 * upload (which AttachmentsService rolls back rather than resumes) never leaves
 * derivative rows behind. Writing a derivative reuses the same durability
 * protocol as a publication — write+fsync a `.stage` sibling, then rename over
 * the final name — because a torn derivative that a later request happily
 * serves is worse than no derivative at all.
 */

/** Max derivative rows processed per drain pass. */
const DERIVATIVE_DRAIN_BATCH = 8;

/**
 * Automatic attempts before a rung is parked as permanently `failed`.
 *
 * Three is enough to ride out a transient ENOSPC/EMFILE, and small enough that a
 * genuinely undecodable image does not spin the worker forever. A parked rung is
 * still recoverable — the DM's "Retry" action resets attempts (see retry()).
 */
const DERIVATIVE_MAX_ATTEMPTS = 3;

/** Retry cadence for the background drain (mirrors FS_DELETION_RETRY_INTERVAL_MS's role). */
const DERIVATIVE_RETRY_INTERVAL_MS = 60_000;

/** Max attachments adopted per boot backfill pass (see backfillMissingPlans). */
const DERIVATIVE_BACKFILL_BATCH = 200;

/**
 * The wire contract lives in @campfire/schema (AttachmentDerivative /
 * AttachmentDerivativeManifest) so the web client's srcset + processing/stale/error
 * rendering cannot drift from what the server actually reports.
 */
export type DerivativeRecord = AttachmentDerivative;
export type DerivativeManifest = AttachmentDerivativeManifest;

type DerivativeRow = typeof attachmentDerivatives.$inferSelect;

@Injectable()
export class AttachmentDerivativesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentDerivativesService.name);
  /** Serialize drain runs so boot/interval/kick passes cannot overlap. */
  private drainInFlight: Promise<number> | null = null;
  /**
   * Set when a drain is requested while one is already running. The in-flight pass
   * snapshotted its work BEFORE those rows existed, so simply returning it would
   * silently drop them (an upload's kick landing mid-drain would then wait a full
   * retry interval). The running pass loops once more instead.
   */
  private rerunRequested = false;
  /** Set while a kick is already scheduled, so N uploads do not schedule N drains. */
  private kickScheduled = false;
  /**
   * Latched by onModuleDestroy. Image work is long-running relative to shutdown, so
   * without this a drain that is mid-render when the app closes would come back to a
   * closed database (and, in tests, a deleted data directory) and throw from a
   * detached promise — a crash with no request to attribute it to.
   */
  private stopped = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Adopt any pre-#604 (or previously-unplannable) attachments, then drain.
   *
   * Recovery semantics: a `pending` row is simply picked up again — unlike an
   * interrupted attachment RESERVATION (which AttachmentsService rolls back
   * because the caller never got a committed result), a pending derivative has
   * no caller waiting on it and its source bytes are already durable, so
   * resuming is both safe and the desired behaviour.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      // Awaited, not fire-and-forget: the drain below must see the rows this
      // plans, otherwise a freshly-adopted attachment waits a full retry interval
      // before anything happens to it.
      await this.backfillMissingPlans();
    } catch (err) {
      // A backfill failure must never stop the server from starting; the next
      // boot (or the next upload's kick) retries.
      this.logger.error(
        `Derivative backfill failed during startup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.drainQueue('boot');
    this.retryTimer = setInterval(() => {
      void this.drainQueue('interval');
    }, DERIVATIVE_RETRY_INTERVAL_MS);
    this.retryTimer.unref();
  }

  /**
   * Stop accepting work and let the in-flight pass finish its current rung before
   * shutdown proceeds. Awaiting the drain is deliberate: derivative generation
   * touches both SQLite and the uploads tree, and both are torn down immediately
   * after this hook returns.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      await this.drainInFlight;
    } catch {
      // Any real failure was already logged by the drain itself; shutdown must
      // not be blocked by it.
    }
  }

  // ---------- planning ----------

  /**
   * Plan the ladder for a freshly committed attachment and schedule a drain.
   *
   * Returns immediately: the only work done on the caller's (request) thread is
   * a header probe + a few INSERTs. The O(pixels) render happens in the drain.
   * `probe` may be supplied by the upload path, which already validated the
   * header, so a normal upload costs exactly one probe in total.
   */
  async planForAttachment(
    row: { id: number; campaignId: number; mime: string },
    probe?: { width: number; height: number },
  ): Promise<void> {
    if (!isDerivableMime(row.mime)) return;
    let dims = probe ?? null;
    if (!dims) {
      try {
        const bytes = await fs.promises.readFile(attachmentFilePath(row));
        dims = await probeImageWithinLimits(bytes);
      } catch (err) {
        // No usable header: record every rung as failed so the manifest can show
        // an honest error state instead of an eternal "processing…" spinner.
        this.recordPlanFailure(row, err);
        return;
      }
    }
    const ts = nowIso();
    for (const spec of DERIVATIVE_LADDER) {
      const state: DerivativeState = shouldMaterialise(dims, spec) ? 'pending' : 'skipped';
      this.upsertPlanRow(row, spec.name, state, ts);
    }
    this.kick();
  }

  /**
   * Insert (or reset) the plan row for one rung. Idempotent via the
   * UNIQUE(attachment_id, variant) constraint, so replanning after a retry or a
   * source replacement never duplicates rungs.
   */
  private upsertPlanRow(
    row: { id: number; campaignId: number },
    variant: DerivativeVariantName,
    state: DerivativeState,
    ts: string,
    lastError = '',
  ): void {
    this.db.run(sql`
      INSERT INTO attachment_derivatives (
        attachment_id, campaign_id, variant, state, format, width, height, bytes,
        checksum, source_etag, attempts, last_error, created_at, updated_at
      )
      VALUES (
        ${row.id}, ${row.campaignId}, ${variant}, ${state}, '', 0, 0, 0,
        '', '', 0, ${lastError}, ${ts}, ${ts}
      )
      ON CONFLICT (attachment_id, variant) DO UPDATE SET
        state = excluded.state,
        attempts = 0,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `);
  }

  /** Park the whole ladder as `failed` when the source header cannot be read at all. */
  private recordPlanFailure(row: { id: number; campaignId: number }, err: unknown): void {
    const message =
      err instanceof ImageLimitError
        ? `${err.reason}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    this.logger.warn(`Cannot plan derivatives for attachment ${row.id}: ${message}`);
    const ts = nowIso();
    for (const spec of DERIVATIVE_LADDER) {
      this.upsertPlanRow(row, spec.name, 'failed', ts, message.slice(0, 500));
    }
  }

  /**
   * Adopt committed image attachments that have no ladder yet — pre-#604 rows,
   * and rows whose plan was lost (e.g. a restore that swapped in an older DB).
   *
   * Bounded to DERIVATIVE_BACKFILL_BATCH per boot so a server with 100k
   * attachments does not spend its startup planning; the remainder is adopted on
   * subsequent boots. Planning here is intentionally header-only — the render
   * cost is still paid by the drain.
   */
  private async backfillMissingPlans(): Promise<void> {
    const rows = this.db.all<{ id: number; campaignId: number; mime: string }>(sql`
      SELECT a.id AS id, a.campaign_id AS campaignId, a.mime AS mime
      FROM attachments AS a
      WHERE a.state = ${ATTACHMENT_STATE_COMMITTED}
        AND a.mime LIKE 'image/%'
        AND NOT EXISTS (SELECT 1 FROM attachment_derivatives AS d WHERE d.attachment_id = a.id)
      ORDER BY a.id DESC
      LIMIT ${DERIVATIVE_BACKFILL_BATCH}
    `);
    if (rows.length === 0) return;
    this.logger.log(`Planning responsive derivatives for ${rows.length} existing attachment(s) (#604 backfill)`);
    for (const row of rows) {
      // Per-row isolation: one unreadable original must not abort the whole
      // backfill. planForAttachment already records its own failure state.
      try {
        await this.planForAttachment(row);
      } catch (err) {
        this.logger.warn(
          `Derivative backfill failed for attachment ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ---------- draining ----------

  /**
   * Schedule a drain on a later tick. Called from request paths (upload, retry)
   * so the HTTP response is never blocked by image work.
   */
  kick(): void {
    if (this.stopped || this.kickScheduled) return;
    this.kickScheduled = true;
    const timer = setImmediate(() => {
      this.kickScheduled = false;
      void this.drainQueue('kick');
    });
    // Never hold the process open for a derivative — tests and CLI runs must exit.
    timer.unref?.();
  }

  /**
   * Process up to DERIVATIVE_DRAIN_BATCH pending rungs, oldest first. Returns the
   * number of rungs that reached `ready`. Serialized: concurrent callers await
   * the in-flight pass rather than starting a second one, so image decoding is
   * strictly one-at-a-time and the memory ceiling stays at a single
   * ATTACHMENT_MAX_IMAGE_PIXELS RGBA plane.
   */
  async drainQueue(reason: 'boot' | 'interval' | 'kick' | 'manual'): Promise<number> {
    if (this.stopped) return 0;
    if (this.drainInFlight) {
      this.rerunRequested = true;
      return this.drainInFlight;
    }
    const run = this.runDrainLoop(reason).finally(() => {
      this.drainInFlight = null;
    });
    this.drainInFlight = run;
    return run;
  }

  /** Run passes until nothing further was requested while the last one was running. */
  private async runDrainLoop(reason: string): Promise<number> {
    let total = 0;
    do {
      this.rerunRequested = false;
      total += await this.runDrain(reason);
    } while (this.rerunRequested && !this.stopped);
    return total;
  }

  /**
   * One pass over the backlog, in ascending-id batches.
   *
   * The ascending CURSOR is load-bearing: a rung that fails below the attempt cap
   * is put back to `pending`, and its id is already behind the cursor, so this pass
   * cannot pick it up again and spin. Rows inserted mid-pass get higher ids and
   * ARE picked up, which is what lets a burst of uploads drain in one go. Each
   * batch awaits image work, so the event loop is yielded constantly rather than
   * being monopolised by a large backlog.
   */
  private async runDrain(reason: string): Promise<number> {
    let ready = 0;
    let attempted = 0;
    let cursor = 0;

    for (;;) {
      if (this.stopped) break;
      const pending = await this.db
        .select()
        .from(attachmentDerivatives)
        .where(and(eq(attachmentDerivatives.state, 'pending'), gt(attachmentDerivatives.id, cursor)))
        .orderBy(asc(attachmentDerivatives.id))
        .limit(DERIVATIVE_DRAIN_BATCH);
      if (pending.length === 0) break;
      cursor = pending[pending.length - 1].id;
      attempted += pending.length;

      // Group by attachment so one source read serves every pending rung of an image.
      const byAttachment = new Map<number, DerivativeRow[]>();
      for (const row of pending) {
        const list = byAttachment.get(row.attachmentId) ?? [];
        list.push(row);
        byAttachment.set(row.attachmentId, list);
      }
      for (const [attachmentId, rungs] of byAttachment) {
        ready += await this.generateForAttachment(attachmentId, rungs);
      }
    }

    if (attempted > 0) {
      this.logger.log(`Derivative drain (${reason}) generated ${ready}/${attempted} rung(s)`);
    }
    return ready;
  }

  private async generateForAttachment(attachmentId: number, rungs: DerivativeRow[]): Promise<number> {
    const [attachment] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.state, ATTACHMENT_STATE_COMMITTED)))
      .limit(1);
    if (!attachment) {
      // The attachment vanished (deleted / rolled back) between planning and
      // draining. Drop the orphan rungs rather than retrying them forever.
      await this.db.delete(attachmentDerivatives).where(eq(attachmentDerivatives.attachmentId, attachmentId));
      return 0;
    }

    const sourcePath = attachmentFilePath(attachment);
    let source: Buffer;
    try {
      source = await fs.promises.readFile(sourcePath);
    } catch (err) {
      this.failRungs(rungs, `source unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    if (this.stopped) return 0;
    const sourceEtag = crypto.createHash('sha256').update(source).digest('hex');

    // Re-validate on the worker even though upload already did: a restore or a
    // pre-#604 row can put bytes on disk that never passed the caps.
    try {
      await probeImageWithinLimits(source);
    } catch (err) {
      this.failRungs(rungs, err instanceof Error ? err.message : String(err));
      return 0;
    }

    let ready = 0;
    for (const rung of rungs) {
      if (this.stopped) break;
      const spec = DERIVATIVE_LADDER.find((candidate) => candidate.name === rung.variant);
      if (!spec) {
        // A rung name this build no longer knows (downgrade). Drop it.
        await this.db.delete(attachmentDerivatives).where(eq(attachmentDerivatives.id, rung.id));
        continue;
      }
      try {
        const rendered = await renderDerivative(source, spec);
        this.writeDerivativeDurably(attachment, spec.name, rendered.bytes);
        this.db
          .update(attachmentDerivatives)
          .set({
            state: 'ready',
            format: DERIVATIVE_MIME,
            width: rendered.width,
            height: rendered.height,
            bytes: rendered.bytes.length,
            checksum: rendered.checksum,
            sourceEtag,
            attempts: rung.attempts + 1,
            lastError: '',
            updatedAt: nowIso(),
          })
          .where(eq(attachmentDerivatives.id, rung.id))
          .run();
        ready += 1;
      } catch (err) {
        this.failRungs([rung], err instanceof Error ? err.message : String(err));
      }
    }
    return ready;
  }

  /**
   * Write derivative bytes durably: stage sibling → fsync → rename over the final
   * name. Rename (not link, as publication uses) is correct here because a
   * derivative CAN legitimately be replaced — a retry or a stale regeneration
   * overwrites the previous rung — while publication must never clobber an
   * existing original.
   */
  private writeDerivativeDurably(
    row: { campaignId: number; id: number },
    variant: DerivativeVariantName,
    bytes: Buffer,
  ): void {
    const finalPath = derivativeFilePath(row, variant);
    const stagePath = `${finalPath}${STAGE_SUFFIX}`;
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagePath, 'w', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    fs.renameSync(stagePath, finalPath);
  }

  /** Mark rungs failed, parking them once DERIVATIVE_MAX_ATTEMPTS is reached. */
  private failRungs(rungs: DerivativeRow[], message: string): void {
    // Shutdown latched between the failure and this write: the database is on its
    // way out, so recording the attempt would throw. The rung stays `pending` and
    // the next boot's drain retries it — which is exactly the durable behaviour.
    if (this.stopped) return;
    const ts = nowIso();
    for (const rung of rungs) {
      const attempts = rung.attempts + 1;
      this.db
        .update(attachmentDerivatives)
        .set({
          // Below the cap we go back to `pending` so the interval retries; at the
          // cap we park as `failed`, which is what the UI surfaces with a Retry.
          state: attempts >= DERIVATIVE_MAX_ATTEMPTS ? 'failed' : 'pending',
          attempts,
          lastError: message.slice(0, 500),
          updatedAt: ts,
        })
        .where(eq(attachmentDerivatives.id, rung.id))
        .run();
      this.logger.warn(
        `Derivative ${rung.variant} for attachment ${rung.attachmentId} failed (attempt ${attempts}): ${message}`,
      );
    }
  }

  // ---------- serving ----------

  /**
   * Best ready rung for a requested size, or null to fall back to the original.
   *
   * "Best" = the requested rung if it is ready, else the largest ready rung that
   * is still no larger than the request (never upscale a smaller rung into a
   * bigger slot — that would look worse than the original). Synchronous: this
   * runs on the request path and must stay a single indexed SELECT, never a
   * decode.
   */
  resolveBest(
    attachmentId: number,
    requested: DerivativeVariantName,
  ): { variant: DerivativeVariantName; width: number; height: number; bytes: number } | null {
    const requestedIndex = DERIVATIVE_LADDER.findIndex((spec) => spec.name === requested);
    if (requestedIndex < 0) return null;
    const candidates = DERIVATIVE_LADDER.slice(0, requestedIndex + 1).map((spec) => spec.name);
    const rows = this.db
      .select()
      .from(attachmentDerivatives)
      .where(
        and(
          eq(attachmentDerivatives.attachmentId, attachmentId),
          eq(attachmentDerivatives.state, 'ready'),
          inArray(attachmentDerivatives.variant, candidates as string[]),
        ),
      )
      .all();
    if (rows.length === 0) return null;
    // Largest ready rung at or below the request.
    let best: DerivativeRow | null = null;
    for (const row of rows) {
      const rank = candidates.indexOf(row.variant as DerivativeVariantName);
      const bestRank = best ? candidates.indexOf(best.variant as DerivativeVariantName) : -1;
      if (rank > bestRank) best = row;
    }
    if (!best) return null;
    return {
      variant: best.variant as DerivativeVariantName,
      width: best.width,
      height: best.height,
      bytes: best.bytes,
    };
  }

  // ---------- status / recovery ----------

  /**
   * Manifest for one attachment: what the responsive `srcset` may reference, and
   * the processing/stale/error state the map surfaces render.
   *
   * `currentSourceEtag` (when the caller already has it) turns a rung generated
   * from replaced bytes into an explicit STALE flag rather than a silent wrong
   * image. Attachment bytes are write-once for a given id, so this only fires
   * after a restore that reused an id — rare, and exactly the case where showing
   * a stale badge beats showing yesterday's map with no warning.
   */
  manifest(attachmentId: number, currentSourceEtag?: string): DerivativeManifest {
    const rows = this.db
      .select()
      .from(attachmentDerivatives)
      .where(eq(attachmentDerivatives.attachmentId, attachmentId))
      .all();

    const derivatives: DerivativeRecord[] = rows
      .map((row) => ({
        variant: row.variant as DerivativeVariantName,
        state: row.state as DerivativeState,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        format: row.format,
        attempts: row.attempts,
        lastError: row.lastError,
        stale:
          row.state === 'ready' &&
          currentSourceEtag !== undefined &&
          row.sourceEtag !== '' &&
          row.sourceEtag !== currentSourceEtag,
      }))
      // Ladder order, so the client can build an ascending srcset without sorting.
      .sort(
        (a, b) =>
          DERIVATIVE_LADDER.findIndex((s) => s.name === a.variant) -
          DERIVATIVE_LADDER.findIndex((s) => s.name === b.variant),
      );

    const status: DerivativeManifest['status'] =
      derivatives.length === 0
        ? 'unsupported'
        : derivatives.some((d) => d.state === 'pending')
          ? 'processing'
          : derivatives.some((d) => d.state === 'failed')
            ? 'failed'
            : 'ready';

    return {
      attachmentId,
      status,
      stale: derivatives.some((d) => d.stale),
      derivatives,
    };
  }

  /**
   * DM-triggered recovery: re-plan the whole ladder and kick the drain.
   *
   * Resets `attempts` (so a rung parked at DERIVATIVE_MAX_ATTEMPTS is eligible
   * again) and re-derives skip decisions from the CURRENT source header — which
   * is what makes this the correct action after a restore replaced the bytes, not
   * just after a transient failure.
   */
  async retry(row: { id: number; campaignId: number; mime: string }): Promise<DerivativeManifest> {
    await this.db.delete(attachmentDerivatives).where(eq(attachmentDerivatives.attachmentId, row.id));
    await this.planForAttachment(row);
    return this.manifest(row.id);
  }

  /** Absolute paths of every derivative artifact an attachment could own. */
  derivativePathsFor(row: { campaignId: number; id: number }): string[] {
    return DERIVATIVE_LADDER.map((spec) => derivativeFilePath(row, spec.name));
  }

  /** Drop an attachment's ladder rows (bytes are erased through fs_deletion_queue). */
  forgetAttachment(attachmentId: number): void {
    this.db.delete(attachmentDerivatives).where(eq(attachmentDerivatives.attachmentId, attachmentId)).run();
  }
}
