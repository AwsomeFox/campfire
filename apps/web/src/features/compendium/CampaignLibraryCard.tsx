import { useState } from 'react';
import type { CampaignLibraryMonster, CombatantStatblock } from '@campfire/schema';
import { Card, Btn, ErrorNote } from '../../components/ui';
import { api, API, translateApiError } from '../../lib/api';
import { CombatantStatblockEditor } from '../encounters/CombatantStatblockEditor';
import { useTranslation } from 'react-i18next';

export function CampaignLibraryCard({
  monster,
  campaignId,
  isDm,
  canDmWrite,
  ruleSystem,
  onUpdated,
}: {
  monster: CampaignLibraryMonster;
  campaignId: number;
  isDm: boolean;
  canDmWrite: boolean;
  ruleSystem?: string | null;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [editName, setEditName] = useState(monster.name);
  const [editStatblock, setEditStatblock] = useState<CombatantStatblock>(monster.statblock);
  const [cloneName, setCloneName] = useState(`${monster.name} (Copy)`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveEdit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/library/monsters/${monster.id}`, {
        name: editName.trim(),
        statblock: editStatblock,
      });
      setEditing(false);
      onUpdated();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' }));
    } finally {
      setSaving(false);
    }
  };

  const cloneMonster = async () => {
    if (!cloneName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/library/monsters/${monster.id}/clone?name=${encodeURIComponent(cloneName.trim())}`);
      setCloning(false);
      onUpdated();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' }));
    } finally {
      setSaving(false);
    }
  };

  const deleteMonster = async () => {
    if (!window.confirm(`Delete ${monster.name} from campaign library?`)) return;
    setSaving(true);
    setError(null);
    try {
      await api.delete(`${API}/library/monsters/${monster.id}`);
      onUpdated();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'compendium.errors.loadEntry' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card density="compact" elev="sm" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{monster.name}</span>
          <span className="text-muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
            Library Monster · AC {monster.statblock.ac ?? 10}
            {monster.sourceRuleEntryId ? ` · Derived from SRD #${monster.sourceRuleEntryId}` : ''}
          </span>
        </span>
        <span className="tag tag-accent" style={{ fontSize: 9.5, flex: 'none' }}>
          library monster
        </span>
        {isDm && canDmWrite && (
          <span className="flex gap-1.5" style={{ flex: 'none' }}>
            <Btn density="xs" ghost className="text-xs" disabled={saving} onClick={() => setEditing((v) => !v)}>
              {editing ? 'Cancel' : 'Edit'}
            </Btn>
            <Btn density="xs" ghost className="text-xs" disabled={saving} onClick={() => setCloning((v) => !v)}>
              {cloning ? 'Cancel' : 'Clone'}
            </Btn>
            <Btn density="xs" ghost className="text-xs text-rose-400" disabled={saving} onClick={deleteMonster}>
              Delete
            </Btn>
          </span>
        )}
      </div>

      {error && <ErrorNote message={error} />}

      {editing && (
        <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            className="input"
            aria-label="Edit monster name"
            placeholder="Monster name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <CombatantStatblockEditor
            value={editStatblock}
            onChange={setEditStatblock}
            disabled={saving}
            ruleSystem={ruleSystem}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn density="xs" disabled={saving} onClick={saveEdit}>
              {saving ? 'Saving…' : 'Save changes'}
            </Btn>
          </div>
        </div>
      )}

      {cloning && (
        <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: 1 }}
            aria-label="Clone monster name"
            placeholder="New monster name"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
          />
          <Btn density="xs" disabled={saving || !cloneName.trim()} onClick={cloneMonster}>
            {saving ? 'Cloning…' : 'Clone monster'}
          </Btn>
        </div>
      )}
    </Card>
  );
}
