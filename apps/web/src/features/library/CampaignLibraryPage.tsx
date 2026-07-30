import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { api, API, ApiError } from '../../lib/api';
import { Btn, Card, ErrorNote, TextInput } from '../../components/ui';
import { PageHeader } from '../../components/PageHeader';
import { useCampaignAccess } from '../../app/CampaignAccessContext';

type Taxonomy = { id: number; name: string; aliases: string[]; color: string; description: string; parentTagId?: number | null; parentCollectionId?: number | null };
type Entry = { entityType: string; entityId: number; name: string; description: string; tags: Taxonomy[]; collections: Taxonomy[] };
type Search = { items: Entry[]; total: number; facets: { types: { id: string; label: string; count: number }[] } };
type Template = { id: number; entityType: string; name: string };
const SEARCH_DEBOUNCE_MS = 300;
const INITIAL_FILTERS = { q: '', type: '', tagId: '', collectionId: '', visibility: '', status: '', owner: '' };
const BULK_STATUS_VALUES: Record<string, readonly string[]> = {
  quest: ['available', 'active', 'completed', 'failed'],
  location: ['unexplored', 'explored', 'current'],
  faction: ['hostile', 'unfriendly', 'neutral', 'friendly', 'allied'],
};
const BULK_STATUS_TARGETS = new Set([...Object.keys(BULK_STATUS_VALUES), 'npc']);
export function libraryQuery(filters: Record<string, string>) { const params = new URLSearchParams(); for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v); return params.toString(); }
export function libraryTargets(selected: Set<string>) { return [...selected].map((key) => { const [entityType, entityId] = key.split(':'); return { entityType, entityId: Number(entityId) }; }); }
export function libraryBulkRequest(operation: string, selected: Set<string>, extra: Record<string, unknown> = {}) { return { operation, targets: libraryTargets(selected), ...extra }; }
export function operationIdAfterUndo(current: number | null, succeeded: boolean) { return succeeded ? null : current; }

export default function CampaignLibraryPage() {
  const { t } = useTranslation();
  const campaignId = Number(useParams<{ campaignId: string }>().campaignId); const { isDm } = useCampaignAccess();
  const [search, setSearch] = useState<Search | null>(null); const [tags, setTags] = useState<Taxonomy[]>([]); const [collections, setCollections] = useState<Taxonomy[]>([]); const [templates, setTemplates] = useState<Template[]>([]);
  const [filters, setFilters] = useState(INITIAL_FILTERS); const [selected, setSelected] = useState(new Set<string>()); const [operationId, setOperationId] = useState<number | null>(null); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState('');
  const [taxKind, setTaxKind] = useState<'tags' | 'collections'>('tags'); const [tax, setTax] = useState({ name: '', aliases: '', color: '#64748b', description: '', parent: '' }); const [editingId, setEditingId] = useState<number | null>(null); const [statusValue, setStatusValue] = useState(''); const [characterId, setCharacterId] = useState(''); const [templateName, setTemplateName] = useState('');
  // A request-sequence guard so a slower, earlier response (e.g. from a fast
  // keystroke burst) can never overwrite the result of a request issued later.
  const requestSeq = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++requestSeq.current;
    try {
      const query = libraryQuery(filters);
      const request = signal ? { signal } : undefined;
      const [result, nextTags, nextCollections, nextTemplates] = await Promise.all([api.get<Search>(`${API}/campaigns/${campaignId}/library/search?${query}`, request), api.get<Taxonomy[]>(`${API}/campaigns/${campaignId}/library/tags`, request), api.get<Taxonomy[]>(`${API}/campaigns/${campaignId}/library/collections`, request), isDm ? api.get<Template[]>(`${API}/campaigns/${campaignId}/library/templates`, request) : Promise.resolve([])]);
      if (signal?.aborted || seq !== requestSeq.current) return;
      setSearch(result); setTags(nextTags); setCollections(nextCollections); setTemplates(nextTemplates);
    } catch (e) {
      if (signal?.aborted || seq !== requestSeq.current) return;
      setError(e instanceof ApiError ? e.message : 'Could not load library');
    }
  }, [campaignId, filters, isDm]);
  // Debounce filter-driven reloads (every keystroke otherwise re-triggers a
  // full-campaign search); the explicit Filter button still calls load() directly.
  useEffect(() => { const controller = new AbortController(); const timeout = window.setTimeout(() => { void load(controller.signal); }, SEARCH_DEBOUNCE_MS); return () => { controller.abort(); window.clearTimeout(timeout); }; }, [load]);
  const targets = useMemo(() => libraryTargets(selected), [selected]);
  const setFilter = (key: keyof typeof filters, value: string) => setFilters((old) => ({ ...old, [key]: value }));
  const post = async (path: string, body?: unknown) => { try { const result = await api.post<{ operationId?: number }>(`${API}/campaigns/${campaignId}/library/${path}`, body); if (result.operationId) { setOperationId(result.operationId); setNotice(`Applied operation ${result.operationId}.`); } else setNotice('Saved.'); await load(); return result; } catch (e) { setError(e instanceof ApiError ? e.message : 'Update failed'); return null; } };
  const bulk = (operation: string, extra: Record<string, unknown> = {}) => { if (!targets.length) { setError('Select entries first.'); return Promise.resolve(null); } return post('bulk', libraryBulkRequest(operation, selected, extra)); };
  const setBulkStatus = () => {
    if (!targets.length) { setError('Select entries first.'); return Promise.resolve(null); }
    const status = statusValue.trim();
    if (!status) { setError('Enter a status value.'); return Promise.resolve(null); }
    if (targets.some((target) => target.entityType === 'npc') && status.length > 40) { setError('NPC disposition must be 40 characters or fewer.'); return Promise.resolve(null); }
    const unsupported = targets.find((target) => !BULK_STATUS_TARGETS.has(target.entityType));
    if (unsupported) { setError('Set status supports quests, NPCs, locations, and factions.'); return Promise.resolve(null); }
    const invalid = targets.find((target) => {
      const allowed = BULK_STATUS_VALUES[target.entityType];
      return allowed && !allowed.includes(status);
    });
    if (invalid) { setError(`${invalid.entityType} status must be one of: ${BULK_STATUS_VALUES[invalid.entityType].join(', ')}.`); return Promise.resolve(null); }
    return bulk('set_status', { status });
  };
  const moveInventoryToCharacter = () => {
    const id = Number(characterId);
    if (!Number.isInteger(id) || id <= 0) { setError('Enter a positive character id.'); return Promise.resolve(null); }
    return bulk('move_inventory_owner', { ownerType: 'character', characterId: id });
  };
  const taxonomyPayload = () => ({ name: tax.name.trim(), aliases: tax.aliases.split(',').map((v) => v.trim()).filter(Boolean), color: tax.color, description: tax.description, [taxKind === 'tags' ? 'parentTagId' : 'parentCollectionId']: tax.parent ? Number(tax.parent) : null });
  const saveTaxonomy = async () => { if (!tax.name.trim()) return; try { if (editingId == null) await post(taxKind, taxonomyPayload()); else { await api.patch(`${API}/campaigns/${campaignId}/library/${taxKind}/${editingId}`, taxonomyPayload()); setNotice('Taxonomy updated.'); await load(); } setEditingId(null); setTax({ name: '', aliases: '', color: '#64748b', description: '', parent: '' }); } catch (e) { setError(e instanceof ApiError ? e.message : 'Update failed'); } };
  const editTaxonomy = (kind: 'tags' | 'collections', item: Taxonomy) => { setTaxKind(kind); setEditingId(item.id); setTax({ name: item.name, aliases: item.aliases.join(', '), color: item.color, description: item.description, parent: String(item[kind === 'tags' ? 'parentTagId' : 'parentCollectionId'] ?? '') }); };
  return <div className="space-y-4" data-testid="campaign-library-page"><PageHeader title={t('library.title')} subtitle={t('library.subtitle')} />{error ? <ErrorNote message={error} /> : null}{notice ? <p className="text-sm text-muted">{notice}</p> : null}
    <Card className="p-3"><div className="flex flex-wrap gap-2"><TextInput value={filters.q} onChange={(e) => setFilter('q', e.target.value)} placeholder="Search" /><select value={filters.type} onChange={(e) => setFilter('type', e.target.value)}><option value="">All types</option>{search?.facets.types.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select><select value={filters.tagId} onChange={(e) => setFilter('tagId', e.target.value)}><option value="">All tags</option>{tags.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select><select value={filters.collectionId} onChange={(e) => setFilter('collectionId', e.target.value)}><option value="">All collections</option>{collections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select><select value={filters.visibility} onChange={(e) => setFilter('visibility', e.target.value)}><option value="">Any visibility</option><option value="public">Public</option><option value="hidden">Hidden</option></select><TextInput value={filters.status} onChange={(e) => setFilter('status', e.target.value)} placeholder="Status" /><TextInput value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)} placeholder="Owner" /><Btn onClick={() => void load()}>Filter</Btn></div></Card>
    {isDm ? <Card className="p-3 space-y-2"><strong>Selected: {targets.length}</strong><div className="flex flex-wrap gap-2"><Btn onClick={() => void bulk('set_visibility', { visibility: 'hidden' })}>Hide</Btn><Btn onClick={() => void bulk('set_visibility', { visibility: 'public' })}>Show</Btn><TextInput value={statusValue} onChange={(e) => setStatusValue(e.target.value)} placeholder="Status, e.g. active/current/friendly" /><Btn onClick={() => void setBulkStatus()}>Set status</Btn><Btn onClick={() => void bulk('move_inventory_owner', { ownerType: 'party' })}>Owner party</Btn><TextInput value={characterId} onChange={(e) => setCharacterId(e.target.value)} placeholder="Character id" /><Btn onClick={() => void moveInventoryToCharacter()}>Owner character</Btn><Btn onClick={() => void bulk('archive')}>Archive</Btn><Btn onClick={() => void bulk('restore')}>Restore</Btn>{tags.flatMap((x) => [<Btn key={`a${x.id}`} onClick={() => void bulk('add_tag', { taxonomyId: x.id })}>+ tag {x.name}</Btn>, <Btn key={`r${x.id}`} onClick={() => void bulk('remove_tag', { taxonomyId: x.id })}>− tag {x.name}</Btn>])}{collections.flatMap((x) => [<Btn key={`ac${x.id}`} onClick={() => void bulk('add_collection', { taxonomyId: x.id })}>+ collection {x.name}</Btn>, <Btn key={`rc${x.id}`} onClick={() => void bulk('remove_collection', { taxonomyId: x.id })}>− collection {x.name}</Btn>, <Btn key={`mc${x.id}`} onClick={() => void bulk('move_collection', { taxonomyId: x.id })}>Move {x.name}</Btn>])}{operationId ? <Btn onClick={() => void post(`bulk/${operationId}/undo`).then((result) => setOperationId(operationIdAfterUndo(operationId, result != null)))}>Undo {operationId}</Btn> : null}</div></Card> : null}
    <Card className="p-0">{search?.items.map((entry) => <div className="p-3 border-t flex gap-2" key={`${entry.entityType}:${entry.entityId}`}><input type="checkbox" disabled={!isDm} checked={selected.has(`${entry.entityType}:${entry.entityId}`)} onChange={() => setSelected((old) => { const next = new Set(old); const key = `${entry.entityType}:${entry.entityId}`; if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><div className="flex-1"><strong>{entry.name}</strong> <span className="text-muted">{entry.entityType}</span><p className="text-sm text-muted">{entry.description}</p></div>{isDm ? <span><Btn onClick={() => void post(`entities/${entry.entityType}/${entry.entityId}/duplicate`, { name: `${entry.name} copy`, refs: {} })}>Duplicate</Btn> <Btn onClick={() => { if (!templateName) { setError('Enter template name.'); return; } void post('templates', { entityType: entry.entityType, entityId: entry.entityId, name: templateName, description: '' }); }}>Save template</Btn></span> : null}</div>)}</Card>
    {isDm ? <div className="grid gap-4 md:grid-cols-2"><Card className="p-3 space-y-2"><strong>{editingId == null ? 'Create taxonomy' : 'Edit taxonomy'}</strong><div className="flex flex-wrap gap-2"><select value={taxKind} disabled={editingId != null} onChange={(e) => setTaxKind(e.target.value as 'tags' | 'collections')}><option value="tags">Tag</option><option value="collections">Collection</option></select><TextInput value={tax.name} onChange={(e) => setTax((v) => ({ ...v, name: e.target.value }))} placeholder="Name" /><TextInput value={tax.aliases} onChange={(e) => setTax((v) => ({ ...v, aliases: e.target.value }))} placeholder="Aliases" /><input type="color" value={tax.color} onChange={(e) => setTax((v) => ({ ...v, color: e.target.value }))} /><TextInput value={tax.description} onChange={(e) => setTax((v) => ({ ...v, description: e.target.value }))} placeholder="Description" /><select value={tax.parent} onChange={(e) => setTax((v) => ({ ...v, parent: e.target.value }))}><option value="">No parent</option>{(taxKind === 'tags' ? tags : collections).filter((x) => x.id !== editingId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select><Btn onClick={() => void saveTaxonomy()}>{editingId == null ? 'Create' : 'Save'}</Btn>{editingId != null ? <Btn onClick={() => { setEditingId(null); setTax({ name: '', aliases: '', color: '#64748b', description: '', parent: '' }); }}>Cancel</Btn> : null}</div>{tags.map((x) => <div key={`t${x.id}`}>● {x.name} <Btn onClick={() => editTaxonomy('tags', x)}>Edit</Btn></div>)}{collections.map((x) => <div key={`c${x.id}`}>● {x.name} <Btn onClick={() => editTaxonomy('collections', x)}>Edit</Btn></div>)}</Card><Card className="p-3"><strong>Templates</strong><TextInput value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Template name" />{templates.map((x) => <div key={x.id}>{x.name} <Btn onClick={() => void post(`templates/${x.id}/instantiate`, { refs: {} })}>Instantiate</Btn> <Btn onClick={() => void post(`templates/${x.id}/archive`)}>Archive</Btn></div>)}</Card></div> : null}
  </div>;
}
