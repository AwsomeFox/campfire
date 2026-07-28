export type HomebrewEditorDraft = { name: string; slug: string; type: string; summary: string; body: string; rightsStatus: string; license: string; attribution: string; author?: string; sourceUrl: string; dataJson: string };
export function serializeHomebrewEditor(draft: HomebrewEditorDraft, structured: Record<string, string>, raw: boolean): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (draft.sourceUrl && !/^https?:\/\//i.test(draft.sourceUrl)) return { ok: false, error: 'Source URL must be http(s).' };
  if (draft.rightsStatus === 'open_licensed' && (!draft.license.trim() || (!draft.attribution.trim() && !draft.author?.trim()) || !draft.sourceUrl.trim())) return { ok: false, error: 'Open-licensed work requires license, attribution, and source URL.' };
  if (draft.rightsStatus === 'permission_granted' && !draft.attribution.trim() && !draft.author?.trim()) return { ok: false, error: 'Permission-granted work requires attribution or author.' };
  let data: Record<string, unknown>;
  if (raw) { try { const value: unknown = JSON.parse(draft.dataJson); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); data = value as Record<string, unknown>; } catch { return { ok: false, error: 'Raw data must be a JSON object.' }; } }
  else { data = Object.fromEntries(Object.entries(structured).filter(([, value]) => value.trim() !== '')); for (const key of ['level', 'ac', 'hp', 'cr', 'weight', 'value']) if (typeof data[key] === 'string') { const n = Number(data[key]); if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number.` }; data[key] = n; } for (const key of ['abilities', 'actions']) if (typeof data[key] === 'string') try { data[key] = JSON.parse(data[key] as string); } catch { return { ok: false, error: `${key} must be valid JSON.` }; } }
  return { ok: true, value: { ...draft, data, dataJson: undefined } };
}
