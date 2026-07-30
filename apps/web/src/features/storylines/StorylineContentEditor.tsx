import { Btn, ErrorNote, TextArea } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { StaleWriteConflict, type ConflictField } from '../../components/StaleWriteConflict';

export type StorylineContentDraft = { title: string; prose: string };

export function storylineDraftMatches(
  draft: StorylineContentDraft,
  server: { title: string; prose: string },
): boolean {
  return draft.title.trim() === server.title && draft.prose === server.prose;
}

type StorylineContentEditorProps = {
  idPrefix: string;
  proseLabel: string;
  draft: StorylineContentDraft;
  onDraftChange: (draft: StorylineContentDraft) => void;
  showPreview: boolean;
  onShowPreviewChange: (show: boolean) => void;
  saving: boolean;
  error: string | null;
  conflict: { base: StorylineContentDraft; theirs: StorylineContentDraft } | null;
  conflictFields: Array<ConflictField<StorylineContentDraft>>;
  onResolveConflict: (key: keyof StorylineContentDraft, value: StorylineContentDraft[keyof StorylineContentDraft]) => void;
  onReloadAllConflict: () => void;
  onSave: () => void;
  onCancel: () => void;
};

export function StorylineContentEditor({
  idPrefix,
  proseLabel,
  draft,
  onDraftChange,
  showPreview,
  onShowPreviewChange,
  saving,
  error,
  conflict,
  conflictFields,
  onResolveConflict,
  onReloadAllConflict,
  onSave,
  onCancel,
}: StorylineContentEditorProps) {
  const titleId = `${idPrefix}-title`;
  const proseId = `${idPrefix}-prose`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {conflict && (
        <StaleWriteConflict
          base={conflict.base}
          mine={draft}
          theirs={conflict.theirs}
          fields={conflictFields}
          onResolve={onResolveConflict}
          onReloadAll={onReloadAllConflict}
        />
      )}
      {error && <ErrorNote message={error} />}
      <div className="field" style={{ marginBottom: 0, minWidth: 0 }}>
        <label htmlFor={titleId}>Title</label>
        <input
          id={titleId}
          className="input"
          value={draft.title}
          maxLength={200}
          required
          disabled={saving}
          onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          style={{ fontSize: 14 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className={`btn btn-ghost ${!showPreview ? 'btn-primary' : ''}`}
          style={{ fontSize: 11 }}
          aria-pressed={!showPreview}
          onClick={() => onShowPreviewChange(false)}
        >
          Write
        </button>
        <button
          type="button"
          className={`btn btn-ghost ${showPreview ? 'btn-primary' : ''}`}
          style={{ fontSize: 11 }}
          aria-pressed={showPreview}
          onClick={() => onShowPreviewChange(true)}
        >
          Preview
        </button>
      </div>
      {showPreview ? (
        <div className="rounded-md border border-[var(--color-divider,rgba(255,255,255,0.08))] p-3 min-h-[80px]">
          {draft.prose.trim() ? (
            <Markdown className="text-muted text-[13px]">{draft.prose}</Markdown>
          ) : (
            <p className="text-muted m-0 text-[13px] italic">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <div className="field" style={{ marginBottom: 0, minWidth: 0 }}>
          <label htmlFor={proseId}>{proseLabel}</label>
          <TextArea
            id={proseId}
            rows={5}
            value={draft.prose}
            maxLength={50_000}
            disabled={saving}
            onChange={(event) => onDraftChange({ ...draft, prose: event.target.value })}
            style={{ fontSize: 13, minHeight: 100 }}
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn onClick={onSave} disabled={saving || !draft.title.trim()} style={{ fontSize: 12 }}>
          {saving ? 'Saving…' : conflict ? 'Save resolution' : 'Save'}
        </Btn>
        <Btn ghost onClick={onCancel} disabled={saving} style={{ fontSize: 12 }}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}
