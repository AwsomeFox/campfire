import fs from 'node:fs';
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Encounter, Role } from '@campfire/schema';
import { fogConcealsPixels } from '../../common/fog';
import { AttachmentsService } from '../attachments/attachments.service';
import { renderFogSafeMap } from './fog-map.renderer';

export interface EncounterMapView {
  bytes: Buffer;
  mime: string;
  etag: string;
  filename: string;
  protected: boolean;
}

interface CachedMapView extends EncounterMapView {
  key: string;
}

const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Produces the role-specific bytes behind GET /encounters/:id/map.
 *
 * The source attachment remains DM-only while fog conceals pixels. Non-DMs get
 * an opaque raster containing only the revealed regions. Rendered revisions are
 * cached in a bounded in-process LRU so pan/zoom and polling do not re-run image
 * decoding, while HTTP responses remain no-store to avoid browser/SW role leaks.
 */
@Injectable()
export class EncounterMapService {
  private readonly cache = new Map<string, CachedMapView>();
  private readonly pending = new Map<string, Promise<CachedMapView>>();
  private cacheBytes = 0;

  constructor(private readonly attachments: AttachmentsService) {}

  async resolve(
    encounter: Encounter,
    role: Role,
    variant: 'original' | 'thumb',
    persistedFogInvalid = false,
  ): Promise<EncounterMapView> {
    if (encounter.mapAttachmentId == null) {
      throw new NotFoundException(`Encounter ${encounter.id} has no battle map`);
    }
    const row = await this.attachments.getRowOrThrow(encounter.mapAttachmentId);
    if (row.campaignId !== encounter.campaignId) {
      // A corrupt/cross-campaign FK must fail closed rather than expose bytes.
      throw new NotFoundException(`Encounter ${encounter.id} battle map not found`);
    }

    // Protect when THIS encounter's fog conceals pixels OR (for non-DMs) when the
    // same attachment is still fog-protected by ANY sibling encounter. Without the
    // sibling check, a player could open a second encounter that reuses the map
    // with fog off/disabled and receive the full source while the first fight
    // still treats the image as secret (#463).
    const thisConceals = persistedFogInvalid || fogConcealsPixels(encounter.fog);
    const siblingProtects =
      role !== 'dm' &&
      !thisConceals &&
      (await this.attachments.isFogProtectedEncounterMap(row.id, encounter.campaignId));
    const protectedView = role !== 'dm' && (thisConceals || siblingProtects);
    // When protection comes from invalid fog or a sibling encounter (not this
    // encounter's own reveal mask), fail closed with an empty reveal set.
    const revealedForRender =
      persistedFogInvalid || siblingProtects ? [] : (encounter.fog?.revealed ?? []);
    if (!protectedView) {
      const file = this.attachments.resolveFile(row, variant);
      try {
        const bytes = await fs.promises.readFile(file.path);
        return { bytes, mime: file.mime, etag: file.etag, filename: row.filename, protected: false };
      } catch {
        throw new NotFoundException(`Encounter ${encounter.id} battle map file is missing`);
      }
    }

    // resolveFile's strong content hash is memoized by mtime/size, so cache hits do
    // not re-read and hash a multi-MB source. The source itself is read only when a
    // role/fog revision is not already in the render LRU.
    const original = this.attachments.resolveFile(row, 'original');
    const key = `${original.etag}:${variant}:${JSON.stringify(revealedForRender)}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    let source: Buffer;
    try {
      source = await fs.promises.readFile(original.path);
    } catch {
      throw new NotFoundException(`Encounter ${encounter.id} battle map file is missing`);
    }
    const render = this.renderProtected(key, source, revealedForRender, variant, row.filename);
    this.pending.set(key, render);
    try {
      return await render;
    } finally {
      this.pending.delete(key);
    }
  }

  private async renderProtected(
    key: string,
    source: Buffer,
    revealed: NonNullable<Encounter['fog']>['revealed'],
    variant: 'original' | 'thumb',
    filename: string,
  ): Promise<CachedMapView> {
    try {
      const rendered = await renderFogSafeMap(source, revealed, variant);
      const result: CachedMapView = {
        key,
        bytes: rendered.bytes,
        mime: 'image/png',
        etag: rendered.etag,
        filename: `fogged-${filename.replace(/\.[^.]+$/, '')}.png`,
        protected: true,
      };
      this.remember(result);
      return result;
    } catch {
      // Security boundary: decoding/rendering failure must never fall back to the
      // original attachment, which would disclose every hidden pixel.
      throw new UnprocessableEntityException('Battle map cannot be safely rendered for fog-of-war');
    }
  }

  private remember(entry: CachedMapView): void {
    this.cache.set(entry.key, entry);
    this.cacheBytes += entry.bytes.length;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (oldest) this.cacheBytes -= oldest.bytes.length;
    }
  }
}
