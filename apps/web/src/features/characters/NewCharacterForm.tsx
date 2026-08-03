/**
 * Guided character creation form (issue #719) — ruleset templates, blank sheet path,
 * and plain-language breakdowns. Extracted from PartyPage for readability.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuleSystemAdapter, DdbImportResult } from '@campfire/schema';
import {
  blankCharacterCreate,
  characterCreateFromTemplate,
  findStarterTemplate,
  starterTemplatesForAdapter,
  type CharacterCreationPath,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput } from '../../components/ui';

export function NewCharacterForm({
  campaignId,
  adapter,
  ddbAllowed,
  onCancel,
  onCreated,
  onImportSucceeded,
}: {
  campaignId: number;
  adapter: RuleSystemAdapter;
  ddbAllowed: boolean;
  onCancel?: () => void;
  onCreated: () => void;
  /**
   * Fired the instant a DDB import succeeds, before the summary is shown (issue #1903
   * review). PartyPage's render guard for this form is `creating || party.length === 0` —
   * when the form is open only because the party was empty (`creating` false), the reload
   * this import triggers makes `party.length` become 1, flipping that guard false and
   * unmounting the form (discarding the just-set summary) before the user can read it. The
   * parent should treat this as "keep me open" independent of the party size (e.g. flip its
   * own `creating` flag true) so the summary survives until `onCreated`/`onCancel` fire from
   * the "Done" button.
   */
  onImportSucceeded?: () => void;
}) {
  const templates = useMemo(() => starterTemplatesForAdapter(adapter, 1), [adapter]);
  const [path, setPath] = useState<CharacterCreationPath>('template');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [className, setClassName] = useState('');
  const [level, setLevel] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  const [ddbRef, setDdbRef] = useState('');
  const [importing, setImporting] = useState(false);
  // Issue #1903: the import summary (attacks/spells/slots counts + any text-only entries)
  // is shown before the form closes, so a DM/player sees what needs a manual touch-up
  // instead of discovering it only inside the sheet.
  const [importSummary, setImportSummary] = useState<DdbImportResult['summary'] | null>(null);

  const levelCap = adapter.maxLevel === Infinity ? 99 : adapter.maxLevel;
  const levelNum = Math.max(1, Math.min(levelCap, Number(level) || 1));
  const templatesAtLevel = useMemo(() => starterTemplatesForAdapter(adapter, levelNum), [adapter, levelNum]);
  const selectedTemplate = findStarterTemplate(adapter, templateId, levelNum) ?? templatesAtLevel[0];
  const classField = adapter.characterSheet?.classField ?? { label: 'Class', placeholder: 'Class', required: true, visible: true };

  async function importFromDdb() {
    const ref = ddbRef.trim();
    if (!ref) return;
    setImporting(true);
    setError(null);
    try {
      const body = /^\d+$/.test(ref) ? { ddbId: ref } : { url: ref };
      const res = await api.post<DdbImportResult>(`${API}/campaigns/${campaignId}/characters/import-ddb`, body);
      setDdbRef('');
      // Hold the form open to show what imported (issue #1903) — defer onCreated()/onCancel()
      // to finishDdbImport() (the "Done" button) rather than calling them here. PartyPage wires
      // onCreated to close the create panel and reload the roster; calling it immediately would
      // unmount this form (the render guard is `creating || party.length === 0`, and both
      // closeCreating() and the reload's `loading=true` flip that guard false) before the
      // summary set on the next line ever gets a render — the panel would never be visible.
      // onImportSucceeded fires first so the parent can pin itself open BEFORE that reload
      // lands — needed for the party-was-empty case, where `creating` was never true to
      // begin with (see the prop's own doc comment).
      onImportSucceeded?.();
      setImportSummary(res.summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import from D&D Beyond.");
    } finally {
      setImporting(false);
    }
  }

  function finishDdbImport() {
    setImportSummary(null);
    onCancel?.();
    onCreated();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload =
        path === 'blank'
          ? blankCharacterCreate({
              name,
              species,
              className,
              level: levelNum,
            })
          : selectedTemplate
            ? characterCreateFromTemplate(selectedTemplate, {
                name,
                species,
                level: levelNum,
                status: 'draft',
              })
            : blankCharacterCreate({ name, species, className, level: levelNum });

      await api.post(`${API}/campaigns/${campaignId}/characters`, payload);
      setName('');
      setSpecies('');
      setClassName('');
      setLevel('1');
      onCancel?.();
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the character.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="space-y-1">
        <h2 className="font-bold text-white text-sm">New character</h2>
        <p className="text-xs text-slate-400">
          Pick a {adapter.label} starter template or start a blank sheet. New characters begin as{' '}
          <strong className="text-slate-300">Drafts</strong> until you finish the checklist and mark them Active — drafts are not
          auto-added to encounters.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

      {ddbAllowed && importSummary && (
        <div className="space-y-2 rounded-md border border-emerald-700/60 bg-emerald-950/20 p-3" role="status">
          <span className="text-xs font-bold text-emerald-300 uppercase tracking-wide">{t('characters.ddbImport.summaryTitle')}</span>
          <ul className="space-y-1 text-xs text-slate-300">
            <li>{t('characters.ddbImport.actionsCount', { count: importSummary.actionsImported })}</li>
            <li>{t('characters.ddbImport.spellsCount', { count: importSummary.spellsImported })}</li>
            {importSummary.spellSlotsImported && <li>{t('characters.ddbImport.spellSlotsSet')}</li>}
          </ul>
          {importSummary.textOnly.length > 0 && (
            <div className="text-xs text-amber-300">
              <p>{t('characters.ddbImport.textOnlyIntro')}</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {importSummary.textOnly.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          )}
          {importSummary.entriesOmitted > 0 && (
            <p className="text-xs text-amber-300">{t('characters.ddbImport.entriesOmitted', { count: importSummary.entriesOmitted })}</p>
          )}
          <div className="flex justify-end">
            <Btn type="button" onClick={finishDdbImport}>
              {t('characters.ddbImport.done')}
            </Btn>
          </div>
        </div>
      )}

      {ddbAllowed && !importSummary && (
        <div className="space-y-2 rounded-md border border-slate-700/60 p-3">
          <span className="text-xs font-bold text-secondary uppercase tracking-wide">Import from D&amp;D Beyond</span>
          <div className="flex gap-2">
            <TextInput
              aria-label="D&D Beyond character id or URL"
              placeholder="D&D Beyond id or character URL"
              value={ddbRef}
              onChange={(e) => setDdbRef(e.target.value)}
              maxLength={500}
            />
            <Btn type="button" onClick={importFromDdb} disabled={importing || !ddbRef.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </Btn>
          </div>
          <p className="text-xs text-secondary">Public sheets import as complete, active characters.</p>
        </div>
      )}

      {ddbAllowed && !importSummary && (
        <div className="flex items-center gap-2 text-xs text-secondary">
          <span className="h-px flex-1 bg-slate-700/60" />
          or create in Campfire
          <span className="h-px flex-1 bg-slate-700/60" />
        </div>
      )}

      {!importSummary && (
      <>
      <fieldset className="space-y-2">
        <legend className="text-xs font-bold text-secondary uppercase tracking-wide">How do you want to start?</legend>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-1 cursor-pointer items-start gap-2 rounded-md border border-slate-700/60 p-3 text-sm text-slate-300 has-[:checked]:border-amber-600/60">
            <input
              type="radio"
              name="creation-path"
              checked={path === 'template'}
              onChange={() => setPath('template')}
              className="mt-0.5"
            />
            <span>
              <strong className="text-white">Starter template</strong>
              <span className="mt-0.5 block text-xs text-slate-400">Pre-filled stats, defenses, and a sample action with formula notes.</span>
            </span>
          </label>
          <label className="flex flex-1 cursor-pointer items-start gap-2 rounded-md border border-slate-700/60 p-3 text-sm text-slate-300 has-[:checked]:border-amber-600/60">
            <input
              type="radio"
              name="creation-path"
              checked={path === 'blank'}
              onChange={() => setPath('blank')}
              className="mt-0.5"
            />
            <span>
              <strong className="text-white">Blank sheet</strong>
              <span className="mt-0.5 block text-xs text-slate-400">Name and basics only — you fill in every number on the sheet.</span>
            </span>
          </label>
        </div>
      </fieldset>

      <form onSubmit={submit} className="space-y-3">
        <TextInput
          aria-label="Character name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoFocus
        />
        <div className={classField.visible ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
          <TextInput aria-label="Species" placeholder="Species" value={species} onChange={(e) => setSpecies(e.target.value)} />
          {classField.visible && (
            path === 'blank' ? (
              <TextInput aria-label={classField.label} placeholder={classField.placeholder} value={className} onChange={(e) => setClassName(e.target.value)} />
            ) : (
              <TextInput
                aria-label={classField.label}
                placeholder={classField.placeholder}
                value={selectedTemplate?.className ?? className}
                onChange={(e) => setClassName(e.target.value)}
                readOnly={Boolean(selectedTemplate)}
              />
            )
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-bold text-secondary uppercase tracking-wide">Level</span>
            <TextInput
              type="number"
              min={1}
              max={adapter.maxLevel === Infinity ? 99 : adapter.maxLevel}
              aria-label="Level"
              placeholder="Level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            />
          </label>
          <div />
        </div>

        {path === 'template' && templatesAtLevel.length > 0 && (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs font-bold text-secondary uppercase tracking-wide">Template</span>
              <select
                className="w-full rounded-md border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-sm text-white"
                aria-label="Starter template"
                value={templateId || templatesAtLevel[0].id}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                {templatesAtLevel.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {selectedTemplate && (
              <div className="rounded-md border border-slate-700/40 bg-slate-900/30 p-3 space-y-2 text-xs text-slate-400">
                <p>{selectedTemplate.description}</p>
                <ul className="list-disc pl-4 space-y-0.5" aria-label="How these numbers were calculated">
                  {selectedTemplate.breakdown.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {path === 'blank' && (
          <p className="text-xs text-secondary rounded-md border border-dashed border-slate-700/50 p-2">
            This creates a <strong className="text-slate-400">draft</strong> with no ability scores, AC, or HP. Open the sheet to
            complete the checklist, then set status to Active when ready for encounters.
          </p>
        )}

        <div className="flex gap-2 justify-end">
          {onCancel && (
            <Btn ghost type="button" onClick={onCancel} disabled={saving}>
              Cancel
            </Btn>
          )}
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : path === 'blank' ? 'Create blank draft' : 'Create from template'}
          </Btn>
        </div>
      </form>
      </>
      )}
    </Card>
  );
}
