/**
 * Accessible note visibility picker for My Notes card badges (issue #689).
 *
 * Replaces tap-to-cycle with an explicit listbox menu (StatusMenuButton) that
 * describes each scope. Whisper notes use a static chip instead — they need a
 * chosen recipient and are not selectable here.
 */
import { useTranslation } from 'react-i18next';
import { Chip, type ChipVariant } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { StatusMenuButton } from '../../components/StatusMenuButton';
import { useAnnounce } from '../../components/Announcer';
import { NOTE_VISIBILITY_ICON, UI_ICON_SIZE } from '../../lib/uiIcons';
import {
  NOTE_VISIBILITY_GROUP_LABEL,
  NOTE_VISIBILITY_HELP,
  noteVisibilityOptionLabel,
} from '../../components/noteVisibilityA11y';
import { BADGE_VISIBILITY_OPTIONS, type BadgeVisibility } from './noteVisibilityChange';

const visMeta: Record<
  BadgeVisibility,
  { chip: ChipVariant; slug: string; label: string }
> = {
  private: { chip: 'private', slug: NOTE_VISIBILITY_ICON.private, label: 'Private' },
  dm_shared: { chip: 'dm', slug: NOTE_VISIBILITY_ICON.dm_shared, label: 'Shared with DM' },
  party_shared: {
    chip: 'party',
    slug: NOTE_VISIBILITY_ICON.party_shared,
    label: 'Shared with party',
  },
};

export function NoteVisibilityMenuButton({
  noteId,
  visibility,
  disabled = false,
  onSelect,
  announceFailure,
  failureMessage,
}: {
  noteId: number;
  visibility: BadgeVisibility;
  disabled?: boolean;
  onSelect: (next: BadgeVisibility) => void | Promise<void>;
  announceFailure?: (message: string) => void;
  failureMessage?: string;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const meta = visMeta[visibility];
  const options = BADGE_VISIBILITY_OPTIONS.map((value) => ({
    value,
    accessibleName: noteVisibilityOptionLabel(value),
    label: (
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <GameIcon slug={visMeta[value].slug} size={UI_ICON_SIZE.xs} /> {visMeta[value].label}
        </span>
        <span className="text-[10px] text-slate-400 font-normal leading-snug">
          {NOTE_VISIBILITY_HELP[value]}
        </span>
      </span>
    ),
  }));

  return (
    <div data-testid={`note-visibility-menu-${noteId}`}>
      <StatusMenuButton
        id={`note-vis-${noteId}`}
        unstyled
        className="cf-chip !bg-transparent !border-0 cursor-pointer !p-0"
        triggerLabel={`${NOTE_VISIBILITY_GROUP_LABEL}: ${meta.label}`}
        triggerDescription={`${NOTE_VISIBILITY_HELP[visibility]} Open the menu to choose who can see this note.`}
        value={visibility}
        options={options.map(({ value, label, accessibleName }) => ({ value, label, accessibleName }))}
        disabled={disabled}
        onSelect={onSelect}
        announceFailure={announceFailure ?? announce}
        failureMessage={failureMessage ?? t('notes.couldntUpdateVisibility')}
        triggerText={
          <Chip variant={meta.chip}>
            <span className="inline-flex items-center gap-1">
              <GameIcon slug={meta.slug} size={UI_ICON_SIZE.xs} /> {meta.label}
            </span>
          </Chip>
        }
      />
    </div>
  );
}
