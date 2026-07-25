/**
 * Campaign cover art — deterministic motifs, crop anchors, and overlay presets
 * (issue #676). Covers are generated client-side from a campaign id (or an
 * explicit motif override for future server-backed preferences). Each motif is a
 * restrained gradient family plus an optional CSS motif layer; variants control
 * height and focal crop without re-implementing per screen.
 */

export const CAMPAIGN_COVER_MOTIFS = ['ember', 'hearth', 'arcane', 'moss', 'storm', 'void'] as const;
export type CampaignCoverMotifId = (typeof CAMPAIGN_COVER_MOTIFS)[number];

export type CampaignCoverVariant = 'tile' | 'banner' | 'hero' | 'strip';

export type CampaignCoverCrop = {
  /** Horizontal focal point (0–100) for gradient + motif anchoring. */
  focalX: number;
  /** Vertical focal point (0–100) for gradient + motif anchoring. */
  focalY: number;
};

export type ResolvedCampaignCover = {
  motifId: CampaignCoverMotifId;
  gradient: string;
  /** Optional repeating motif texture layered above the gradient. */
  motifTexture: string | null;
  inkColor: string;
  crop: CampaignCoverCrop;
  overlay: string;
  heightPx: number;
};

const MOTIF_GRADIENTS: Record<CampaignCoverMotifId, string> = {
  ember:
    'linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, var(--color-neutral-900)), var(--color-neutral-900))',
  hearth:
    'linear-gradient(145deg, color-mix(in srgb, var(--cf-crit) 22%, var(--color-neutral-900)), color-mix(in srgb, var(--color-accent) 10%, var(--color-neutral-900)))',
  arcane:
    'linear-gradient(135deg, color-mix(in srgb, var(--color-accent-2) 20%, var(--color-neutral-900)), var(--color-neutral-900))',
  moss:
    'linear-gradient(135deg, color-mix(in srgb, var(--cf-success) 16%, var(--color-neutral-900)), var(--color-neutral-900))',
  storm:
    'linear-gradient(135deg, color-mix(in srgb, var(--cf-threat) 14%, var(--color-neutral-900)), var(--color-neutral-900))',
  void:
    'linear-gradient(135deg, var(--color-neutral-800), var(--color-neutral-900))',
};

const MOTIF_INK: Record<CampaignCoverMotifId, string> = {
  ember: 'var(--color-accent-100)',
  hearth: 'var(--color-accent-200)',
  arcane: 'var(--color-accent-2-200)',
  moss: '#d1fae5',
  storm: '#e0f2fe',
  void: 'var(--color-neutral-300)',
};

/** Subtle dot lattice — echoes the login pitch grid without competing with content. */
function motifTexture(id: CampaignCoverMotifId, focalX: number, focalY: number): string | null {
  const tint =
    id === 'hearth'
      ? '245,158,11'
      : id === 'arcane'
        ? '167,139,250'
        : id === 'moss'
          ? '52,211,153'
          : id === 'storm'
            ? '56,189,248'
            : id === 'void'
              ? '148,163,184'
              : '145,138,252';
  return `radial-gradient(circle at ${focalX}% ${focalY}%, rgba(${tint},0.22) 0.6px, transparent 0.7px)`;
}

const VARIANT_HEIGHT: Record<CampaignCoverVariant, number> = {
  tile: 88,
  banner: 112,
  hero: 168,
  strip: 44,
};

const VARIANT_OVERLAY: Record<CampaignCoverVariant, string> = {
  tile: 'linear-gradient(180deg, transparent 35%, color-mix(in srgb, var(--color-bg) 55%, transparent))',
  banner: 'linear-gradient(180deg, transparent 20%, color-mix(in srgb, var(--color-bg) 72%, transparent))',
  hero: 'linear-gradient(180deg, transparent 10%, color-mix(in srgb, var(--color-bg) 88%, transparent))',
  strip: 'linear-gradient(90deg, color-mix(in srgb, var(--color-bg) 35%, transparent), transparent 65%)',
};

/** Stable crop anchor derived from campaign id so tiles feel unique but reproducible. */
export function cropForCampaign(campaignId: number): CampaignCoverCrop {
  const seed = Math.abs(campaignId);
  return {
    focalX: 28 + (seed % 45),
    focalY: 18 + (seed % 32),
  };
}

export function motifForCampaign(
  campaignId: number,
  motifOverride?: CampaignCoverMotifId | null,
): CampaignCoverMotifId {
  if (motifOverride && CAMPAIGN_COVER_MOTIFS.includes(motifOverride)) return motifOverride;
  return CAMPAIGN_COVER_MOTIFS[Math.abs(campaignId) % CAMPAIGN_COVER_MOTIFS.length];
}

export function resolveCampaignCover(opts: {
  campaignId: number;
  motifId?: CampaignCoverMotifId | null;
  variant?: CampaignCoverVariant;
}): ResolvedCampaignCover {
  const variant = opts.variant ?? 'tile';
  const motifId = motifForCampaign(opts.campaignId, opts.motifId);
  const crop = cropForCampaign(opts.campaignId);
  return {
    motifId,
    gradient: MOTIF_GRADIENTS[motifId],
    motifTexture: motifTexture(motifId, crop.focalX, crop.focalY),
    inkColor: MOTIF_INK[motifId],
    crop,
    overlay: VARIANT_OVERLAY[variant],
    heightPx: VARIANT_HEIGHT[variant],
  };
}

/** Initial shown on a cover when no uploaded art exists. */
export function coverMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = Array.from(trimmed)[0];
  return first ? first.toUpperCase() : '?';
}
