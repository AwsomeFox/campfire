/**
 * API tokens card — shared between AdminPage (server admin console) and
 * TokensPage (per-user, /tokens). Tokens are per-USER: any signed-in user can
 * create/revoke their own tokens regardless of server role.
 * Per design/10-admin.html "API tokens" section.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApiToken, Campaign } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

type TokenScope = ApiToken['scope'];
type ApiTokenCreated = { token: string; apiToken: ApiToken };

const SCOPE_CHIP: Record<TokenScope, string> = {
  dm: 'cf-chip-dm',
  player: 'cf-chip-party',
  viewer: 'cf-chip-private',
};
const SCOPE_LABEL: Record<TokenScope, string> = { dm: 'DM', player: 'Player', viewer: 'Viewer' };
const SCOPE_HELP: Record<TokenScope, string> = {
  dm: 'DM — the AI writes directly (quests, NPCs, encounters, HP…) and can approve proposals.',
  player: 'Player — writes are scoped to that player and become DM proposals, not direct changes.',
  viewer: 'Viewer — read-only; writes are rejected outright.',
};

function mcpConnectCommand(origin: string, token?: string): string {
  const authHeader = token ? `Bearer ${token}` : '<TOKEN>';
  return `claude mcp add --transport http campfire ${origin}/mcp --header "Authorization: ${authHeader}"`;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can still select the text */
    }
  }
  return (
    <Btn className="!min-h-0 !py-1.5 text-xs" onClick={copy}>
      {copied ? 'Copied!' : label}
    </Btn>
  );
}

/**
 * "Connect your AI" block — always-visible tokenless version (persistent on /tokens)
 * unless `token` is supplied, in which case it shows the real command with the
 * one-time secret baked in (only ever rendered inside the just-created reveal).
 */
function ConnectAiBlock({ token }: { token?: string }) {
  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const command = mcpConnectCommand(origin, token);
  return (
    <div className="cf-inset p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Connect your AI</p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-slate-500">MCP endpoint</span>
        <code className="text-xs text-slate-300 font-mono break-all flex-1 min-w-0">{mcpUrl}</code>
        <CopyButton text={mcpUrl} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code className="cf-inset px-3 py-2 text-xs text-slate-300 font-mono break-all flex-1 min-w-0">
          {command}
        </code>
        <CopyButton text={command} />
      </div>
      <p className="text-[11px] text-slate-500">
        {token
          ? 'This command has your new token baked in — copy it now, it will not be shown again.'
          : 'Swap <TOKEN> for a token created above (or use the one-time command shown right after creating one).'}
      </p>
    </div>
  );
}

export function TokensCard() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiToken | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, c] = await Promise.all([
        api.get<ApiToken[]>(`${API}/tokens`),
        api.get<Campaign[]>(`${API}/campaigns`),
      ]);
      setTokens(t);
      setCampaigns(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load API tokens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(token: ApiToken) {
    setRevoking(true);
    setError(null);
    try {
      await api.delete(`${API}/tokens/${token.id}`);
      setConfirmRevoke(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke token.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">
          API tokens <span className="text-slate-500 font-normal">(REST + MCP)</span>
        </h2>
        <Btn
          className="!min-h-0 !py-1.5 text-xs"
          onClick={() => {
            setCreated(null);
            setShowNew((v) => !v);
          }}
        >
          {showNew ? 'Cancel' : '+ New token'}
        </Btn>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {created && <NewTokenReveal created={created} onClose={() => setCreated(null)} />}

      {showNew && !created && (
        <NewTokenForm
          campaigns={campaigns}
          onCancel={() => setShowNew(false)}
          onCreated={(result) => {
            setShowNew(false);
            setCreated(result);
            void load();
          }}
          onError={setError}
        />
      )}

      {loading && !tokens ? (
        <Skeleton lines={3} />
      ) : tokens && tokens.length === 0 ? (
        <EmptyState icon="🔑" title="No tokens yet" hint="Create one above to use the REST API or MCP." />
      ) : (
        <div className="space-y-2">
          {(tokens ?? []).map((t) => (
            <TokenRow key={t.id} token={t} onRevoke={() => setConfirmRevoke(t)} />
          ))}
        </div>
      )}

      {confirmRevoke && (
        <ConfirmDialog
          title={`Revoke token "${confirmRevoke.name}"?`}
          body="Anything using it will stop working immediately."
          confirmLabel={revoking ? 'Revoking…' : 'Revoke'}
          busy={revoking}
          onConfirm={() => revoke(confirmRevoke)}
          onCancel={() => setConfirmRevoke(null)}
        />
      )}

      <ConnectAiBlock />
    </Card>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiToken; onRevoke: () => void }) {
  const campaignBadge = token.campaignId !== null ? `campaign #${token.campaignId}` : 'all campaigns';
  return (
    <div className="cf-inset p-3.5 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <p className="text-sm font-semibold text-white">
          {token.name}{' '}
          <span className={`cf-chip ${SCOPE_CHIP[token.scope]} ml-1`}>{SCOPE_LABEL[token.scope]} scope</span>{' '}
          <span className="cf-chip cf-chip-private ml-1">{campaignBadge}</span>
        </p>
        <p className="text-[11px] text-slate-500">
          {token.tokenPrefix}•••• · last used {token.lastUsedAt ? timeAgo(token.lastUsedAt) : 'never'}
        </p>
      </div>
      <Btn ghost danger className="!min-h-0 !py-1.5 text-xs" onClick={onRevoke}>
        Revoke
      </Btn>
    </div>
  );
}

function NewTokenForm({
  campaigns,
  onCancel,
  onCreated,
  onError,
}: {
  campaigns: Campaign[];
  onCancel: () => void;
  onCreated: (created: ApiTokenCreated) => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('player');
  const [campaignId, setCampaignId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  async function create() {
    if (saving || !name.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const result = await api.post<ApiTokenCreated>(`${API}/tokens`, {
        name: name.trim(),
        scope,
        campaignId: campaignId ? Number(campaignId) : null,
      });
      onCreated(result);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't create token.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cf-inset border-amber-500/30 p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">New token</p>
      <div className="grid sm:grid-cols-3 gap-2">
        <TextInput
          className="!min-h-0 !py-2 text-sm"
          placeholder="Name, e.g. claude-scribe"
          aria-label="Token name (required)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          autoFocus
        />
        <select
          className="cf-select !min-h-0 !py-2 text-sm"
          value={scope}
          onChange={(e) => setScope(e.target.value as TokenScope)}
        >
          <option value="dm">Scope: DM</option>
          <option value="player">Scope: Player</option>
          <option value="viewer">Scope: Viewer</option>
        </select>
        <select
          className="cf-select !min-h-0 !py-2 text-sm"
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
        >
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-[11px] text-slate-500">{SCOPE_HELP[scope]}</p>
      <div className="flex items-center gap-2 justify-end">
        {!name.trim() && <p className="text-[11px] text-slate-500 mr-auto">Name your token to enable Create.</p>}
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn
          className="!min-h-0 !py-1.5 text-xs"
          onClick={create}
          disabled={saving || !name.trim()}
          title={!name.trim() ? 'Enter a token name first' : undefined}
        >
          Create
        </Btn>
      </div>
    </div>
  );
}

function NewTokenReveal({ created, onClose }: { created: ApiTokenCreated; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can still select the text */
    }
  }

  return (
    <div className="cf-dm-panel p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
          🔑 {created.apiToken.name} — shown once
        </p>
        <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={onClose}>
          dismiss
        </button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code className="cf-inset px-3 py-2 text-sm text-amber-300 font-mono break-all flex-1 min-w-0">
          {created.token}
        </code>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </Btn>
      </div>
      <p className="text-[11px] text-slate-400">
        Shown once — save it somewhere safe, or use the ready-to-run command below.
      </p>
      <ConnectAiBlock token={created.token} />
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
