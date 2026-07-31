import { useState } from 'react';
import type { RosterImportCommitResult, RosterImportPreview } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, Btn, ErrorNote } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';

export function RosterImportCard() {
  const { t } = useTranslation();
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<RosterImportPreview | null>(null);
  const [result, setResult] = useState<RosterImportCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);

  async function runDryRun() {
    setBusy('preview');
    setError(null);
    setResult(null);
    try {
      const res = await api.post<RosterImportPreview>(`${API}/admin/roster-import`, {
        dryRun: true,
        format,
        content,
        activationExpiresInDays: 7,
      });
      setPreview(res);
    } catch (err) {
      setPreview(null);
      setError(translateApiError(err, t, { fallbackKey: 'errors.saveFailed' }));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy('commit');
    setError(null);
    try {
      const res = await api.post<RosterImportCommitResult>(`${API}/admin/roster-import`, {
        dryRun: false,
        format,
        content: '[]',
        batchId: preview.batchId,
        rows: preview.commitRows,
        activationExpiresInDays: 7,
      });
      setResult(res);
      setPreview(null);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.saveFailed' }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">Bulk roster import</h2>
        <p className="text-xs text-slate-400 mt-1">
          Paste CSV or JSON, preview validation, then commit reviewed rows. New accounts receive one-time activation codes — copy them immediately.
        </p>
      </div>

      <fieldset className="border-0 p-0 m-0 space-y-1" style={{ minWidth: 0 }}>
        <legend className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Format</legend>
        <div className="flex gap-2 text-xs">
          <label className="flex items-center gap-1 text-slate-300">
            <input type="radio" name="roster-import-format" value="csv" checked={format === 'csv'} onChange={() => setFormat('csv')} /> CSV
          </label>
          <label className="flex items-center gap-1 text-slate-300">
            <input type="radio" name="roster-import-format" value="json" checked={format === 'json'} onChange={() => setFormat('json')} /> JSON
          </label>
        </div>
      </fieldset>

      <textarea
        className="w-full min-h-28 rounded border border-slate-700 bg-slate-900 p-2 text-xs text-slate-100"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={
          format === 'csv'
            ? 'username,displayName,campaignId,role\nalice,Alice Smith,1,player'
            : '[{"username":"alice","displayName":"Alice Smith","campaignId":1,"role":"player"}]'
        }
      />

      {error && <ErrorNote message={error} />}

      <div className="flex gap-2">
        <Btn density="xs" type="button" className="text-xs" disabled={!content.trim() || busy != null} onClick={() => void runDryRun()}>
          {busy === 'preview' ? 'Previewing…' : 'Dry-run preview'}
        </Btn>
        <Btn density="xs"
          type="button"
          className="text-xs"
          disabled={!preview || preview.errorRows > 0 || preview.validRows === 0 || busy != null}
          onClick={() => void commit()}
        >
          {busy === 'commit' ? 'Committing…' : 'Commit reviewed batch'}
        </Btn>
      </div>

      {preview && (
        <div className="text-xs space-y-2">
          <p className="text-slate-300">
            {preview.validRows} valid / {preview.errorRows} error / {preview.totalRows} total
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase text-slate-400">
                  <th className="pr-2">#</th>
                  <th className="pr-2">Action</th>
                  <th className="pr-2">User</th>
                  <th>Diagnostics</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {preview.rows.map((row) => (
                  <tr key={row.rowIndex}>
                    <td className="py-1 pr-2">{row.rowIndex + 1}</td>
                    <td className="py-1 pr-2">{row.action}</td>
                    <td className="py-1 pr-2">{row.username ?? row.oidcSub ?? '—'}</td>
                    <td className="py-1 text-rose-300">{[...row.errors, ...row.warnings].join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="text-xs space-y-2 border-t border-slate-800 pt-3">
          <p className="text-emerald-300">
            Committed: {result.created} created, {result.updated} updated, {result.membershipsAdded} memberships added.
          </p>
          {result.activations.length > 0 && (
            <div>
              <p className="text-amber-300 font-semibold">Activation codes (shown once)</p>
              <ul className="mt-1 space-y-1">
                {result.activations.map((a) => (
                  <li key={a.userId} className="font-mono text-slate-200">
                    {a.username}: {a.activationCode} (expires {formatDateTime(a.expiresAt)})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
