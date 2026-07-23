/**
 * Shared labeled metadata field group for campaign name + description +
 * danger level (issue #750).
 *
 * The dashboard quick edit (StatusHeader) and the Settings > General card
 * (CampaignSettingsPage) edit the same three fields against the same PATCH
 * endpoint. Before this component existed the dashboard rendered placeholder-
 * only inputs with no durable labels, while Settings used properly labeled
 * `<label htmlFor>` pairs — a form-usability and accessibility regression
 * documented in the persona audit. Both surfaces now compose this group so
 * the two editors stay structurally identical: visible labels, stable ids,
 * a required marker on name, character-count help, and an error slot are
 * owned in one place.
 *
 * This component is a controlled presentational group. The parent owns the
 * values, dirty/saving/saved status, and submission. Keeping the submit
 * button out of this group lets each surface keep its own chrome (the
 * dashboard's inline Save/Cancel pair vs Settings' dirty-disabled Save
 * changes CTA) while the inputs themselves are byte-for-byte identical.
 */
import type { Campaign, DangerLevel } from '@campfire/schema';

export const CAMPAIGN_NAME_MAX = 120;
export const CAMPAIGN_DESC_MAX = 10_000;

const DANGER_LEVELS: DangerLevel[] = ['low', 'moderate', 'high', 'deadly'];

function labelForDanger(level: DangerLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export type CampaignMetadataFieldsProps = {
  /** Disambiguates the input ids when the group is mounted twice (it never is today, but guards against future embedding). */
  idPrefix: string;
  name: string;
  description: string;
  dangerLevel: DangerLevel;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onDangerLevelChange: (value: DangerLevel) => void;
  /** Field-level error (e.g. server validation). Rendered with role="alert" so screen readers announce it. */
  error?: string | null;
  /** Disable every control during a save. */
  disabled?: boolean;
  /** Optional aria-describedby id on the host page, so the labelled controls share an error/announcement target. */
  describedBy?: string;
};

export function CampaignMetadataFields({
  idPrefix,
  name,
  description,
  dangerLevel,
  onNameChange,
  onDescriptionChange,
  onDangerLevelChange,
  error,
  disabled,
  describedBy,
}: CampaignMetadataFieldsProps) {
  const nameId = `${idPrefix}-name`;
  const nameHelpId = `${idPrefix}-name-help`;
  const nameErrorId = `${idPrefix}-name-error`;
  const descId = `${idPrefix}-desc`;
  const descHelpId = `${idPrefix}-desc-help`;
  const dangerId = `${idPrefix}-danger`;

  const trimmed = name.trim();
  const nameError = trimmed.length === 0 ? 'Campaign name is required.' : null;
  // Surface the live error when the user has touched the field; otherwise let
  // the parent's submission gate drive the visible message.
  const showNameError = nameError !== null && name.length > 0;
  const nameDescribedBy = [nameHelpId, showNameError ? nameErrorId : null, describedBy]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <>
      <div className="field">
        <label htmlFor={nameId}>
          Name <span aria-hidden="true" style={{ color: 'var(--color-danger, #f87171)' }}>*</span>
          <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}>
            (required)
          </span>
        </label>
        <input
          id={nameId}
          className="input"
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={CAMPAIGN_NAME_MAX}
          required
          aria-required="true"
          aria-invalid={showNameError || undefined}
          aria-describedby={nameDescribedBy}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <p id={nameHelpId} className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {trimmed.length}/{CAMPAIGN_NAME_MAX} characters.
        </p>
        {showNameError && (
          <p id={nameErrorId} role="alert" className="text-sm" style={{ margin: 0, color: 'var(--color-danger, #f87171)' }}>
            {nameError}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor={descId}>Description</label>
        <textarea
          id={descId}
          className="input"
          style={{ minHeight: 90, resize: 'vertical' }}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          maxLength={CAMPAIGN_DESC_MAX}
          aria-describedby={descHelpId}
          disabled={disabled}
        />
        <p id={descHelpId} className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {description.length.toLocaleString()}/{CAMPAIGN_DESC_MAX.toLocaleString()} characters.
        </p>
      </div>

      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor={dangerId}>Danger level</label>
        <select
          id={dangerId}
          className="input"
          value={dangerLevel}
          onChange={(e) => onDangerLevelChange(e.target.value as DangerLevel)}
          disabled={disabled}
        >
          {DANGER_LEVELS.map((level) => (
            <option key={level} value={level}>
              {labelForDanger(level)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="text-sm" style={{ margin: 0, color: 'var(--color-danger, #f87171)' }}>
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Dirty check for the three metadata fields. Used by both surfaces so they
 * agree on when the Save control is live, regardless of whether they store
 * extra fields (e.g. Settings also tracks `dmControlsProgression`).
 */
export function isCampaignMetadataDirty(
  baseline: Pick<Campaign, 'name' | 'description' | 'dangerLevel'>,
  next: Pick<Campaign, 'name' | 'description' | 'dangerLevel'>,
): boolean {
  return (
    next.name !== baseline.name ||
    next.description !== baseline.description ||
    next.dangerLevel !== baseline.dangerLevel
  );
}
