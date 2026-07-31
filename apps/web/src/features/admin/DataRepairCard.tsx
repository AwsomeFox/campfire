import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, API } from '../../lib/api';
import { Btn, Card } from '../../components/ui';
import { formatTime } from '../../lib/format';

type Finding = { id:number; child_table:string; child_row_id:number; child_column:string; parent_table:string; status:string; version:number; detail:string };
type Overview = { openCount:number; history:Array<{id:number; source:string; completed_at:string|null; strict_count:number; soft_count:number}>; actions:Array<{id:number;action:string;status:string}> };
type Preview = { previewToken:string; expiresAt:string; automaticBackup:boolean; dependentRowImpact:number; action:'relink'|'null'|'quarantine' };

/** Server requires a positive integer parent id for relink; reject NaN/0/negatives client-side. */
function parseReplacementParentId(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Deliberately requires a server-generated, short-lived preview before Apply. */
export function DataRepairCard() {
  useTranslation();
  const [overview,setOverview]=useState<Overview|null>(null); const [findings,setFindings]=useState<Finding[]>([]);
  const [preview,setPreview]=useState<Record<number,Preview>>({}); const [replacement,setReplacement]=useState<Record<number,string>>({}); const [error,setError]=useState<string|null>(null); const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{ const [nextOverview,nextFindings]=await Promise.all([api.get<Overview>(`${API}/admin/data-repair`),api.get<Finding[]>(`${API}/admin/data-repair/findings?status=open`)]); setOverview(nextOverview);setFindings(nextFindings);setPreview({}); },[]);
  useEffect(()=>{ void load().catch(error=>setError(error instanceof Error?error.message:'Unable to load repair diagnostics')); },[load]);
  const clearPreview=(id:number)=>setPreview(current=>{ const next={...current};delete next[id];return next; });
  async function scan(){ setBusy(true);try{await api.post(`${API}/admin/data-repair/scan`,{});await load();setError(null);}catch(e){setError(e instanceof Error?e.message:'Scan failed');}finally{setBusy(false);} }
  async function requestPreview(finding:Finding,action:'relink'|'null'|'quarantine') {
    clearPreview(finding.id);
    try {
      const id = parseReplacementParentId(replacement[finding.id]);
      if (action === 'relink' && id == null) {
        setError('Replacement parent ID must be a positive integer.');
        return;
      }
      const result = await api.post<Omit<Preview,'action'>>(`${API}/admin/data-repair/preview`, {
        findingId: finding.id,
        action,
        expectedVersion: finding.version,
        ...(action === 'relink' ? { replacementParentId: id! } : {}),
      });
      setPreview(current => ({ ...current, [finding.id]: { ...result, action } }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    }
  }
  async function apply(finding:Finding) {
    const current = preview[finding.id];
    if (!current) return;
    setBusy(true);
    try {
      const id = parseReplacementParentId(replacement[finding.id]);
      if (current.action === 'relink' && id == null) {
        setError('Replacement parent ID must be a positive integer.');
        return;
      }
      await api.post(`${API}/admin/data-repair/apply`, {
        findingId: finding.id,
        action: current.action,
        expectedVersion: finding.version,
        previewToken: current.previewToken,
        ...(current.action === 'relink' ? { replacementParentId: id! } : {}),
      });
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Repair failed');
    } finally {
      setBusy(false);
    }
  }
  async function undo(id:number){setBusy(true);try{await api.post(`${API}/admin/data-repair/actions/${id}/undo`,{});await load();setError(null);}catch(e){setError(e instanceof Error?e.message:'Undo failed');}finally{setBusy(false);}}
  return <Card className="space-y-3" data-testid="data-repair-card"><div><h2 className="font-bold text-white text-sm">Data repair</h2><p className="text-[11px] text-slate-400">Integrity metadata only. Every change needs a fresh preview and a private backup.</p></div>{error&&<p className="text-xs text-rose-400">{error}</p>}<div className="flex gap-2 items-center"><Btn type="button" onClick={()=>void scan()} disabled={busy}>Run integrity scan</Btn><a className="text-xs underline text-sky-300" href={`${API}/admin/data-repair/support-bundle`}>Download support bundle</a>{overview&&<span className="text-xs text-amber-300">{overview.openCount} open finding{overview.openCount===1?'':'s'}</span>}</div>{findings.map(finding=>{ const replacementId=parseReplacementParentId(replacement[finding.id]); return <div className="cf-inset p-3 space-y-2" key={finding.id}><p className="text-xs text-white">{finding.child_table} row {finding.child_row_id}: <code>{finding.child_column}</code> → {finding.parent_table} <span className="text-slate-400">({finding.detail})</span></p><div className="flex gap-2 flex-wrap"><input className="cf-input text-xs w-28 cf-density-xs" aria-label={`Replacement parent for finding ${finding.id}`} inputMode="numeric" value={replacement[finding.id]??''} onChange={event=>{clearPreview(finding.id);setReplacement(current=>({...current,[finding.id]:event.target.value}));}} placeholder="parent ID"/><Btn type="button" disabled={replacementId==null} onClick={()=>void requestPreview(finding,'relink')}>Preview relink</Btn><Btn type="button" onClick={()=>void requestPreview(finding,'null')}>Preview null</Btn><Btn type="button" onClick={()=>void requestPreview(finding,'quarantine')}>Preview quarantine</Btn></div>{preview[finding.id]&&<div className="text-xs text-amber-200 space-y-1"><p>Previewed {preview[finding.id].action}; expires {formatTime(preview[finding.id].expiresAt)}. {preview[finding.id].dependentRowImpact} dependent rows. A private backup will be created.</p><div className="flex gap-2"><Btn type="button" disabled={busy} onClick={()=>void apply(finding)}>Apply previewed repair</Btn></div></div>}</div>;}) }{overview&&<details className="text-xs text-slate-400"><summary>Recent scans</summary>{overview.history.map(run=><p key={run.id}>#{run.id} {run.source}: {run.strict_count} strict / {run.soft_count} soft</p>)}{overview.actions.map(action=><div key={action.id} className="flex gap-2"><span>Repair #{action.id} ({action.action})</span><Btn type="button" disabled={busy} onClick={()=>void undo(action.id)}>Undo safely</Btn></div>)}</details>}</Card>;
}
