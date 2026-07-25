/**
 * Campaign cover strip — gradient, generated motif texture, crop anchor, and
 * legibility overlay (issue #676). Used on the hub tiles, dashboard banner,
 * and other brand moments that need a consistent campfire/fantasy read.
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  coverMonogram,
  resolveCampaignCover,
  type CampaignCoverMotifId,
  type CampaignCoverVariant,
} from '../lib/campaignCover';

export function CampaignCover({
  campaignId,
  name,
  motifId,
  variant = 'tile',
  archived,
  showMonogram = true,
  monogram,
  className,
  style,
  children,
}: {
  campaignId: number;
  name: string;
  motifId?: CampaignCoverMotifId | null;
  variant?: CampaignCoverVariant;
  archived?: boolean;
  /** Override the default first-letter monogram. */
  monogram?: ReactNode;
  /** When false, omit the default monogram (banner strips). */
  showMonogram?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const cover = resolveCampaignCover({ campaignId, motifId, variant });
  const letter = monogram ?? (
    <span
      className="cf-cover-monogram"
      style={{ color: cover.inkColor }}
      aria-hidden={name.trim() ? undefined : true}
    >
      {coverMonogram(name)}
    </span>
  );

  return (
    <div
      className={['cf-campaign-cover', className].filter(Boolean).join(' ')}
      data-motif={cover.motifId}
      data-variant={variant}
      style={{
        height: cover.heightPx,
        background: cover.gradient,
        backgroundPosition: `${cover.crop.focalX}% ${cover.crop.focalY}%`,
        ...(archived ? { filter: 'saturate(0.45)' } : {}),
        ...style,
      }}
    >
      {cover.motifTexture && (
        <div
          className="cf-campaign-cover__texture"
          aria-hidden
          style={{
            backgroundImage: cover.motifTexture,
            backgroundSize: '18px 18px',
            backgroundPosition: `${cover.crop.focalX}% ${cover.crop.focalY}%`,
          }}
        />
      )}
      <div className="cf-campaign-cover__overlay" aria-hidden style={{ background: cover.overlay }} />
      <div className="cf-campaign-cover__content">
        {children ?? (showMonogram ? letter : null)}
      </div>
    </div>
  );
}
