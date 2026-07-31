import { useTranslation } from 'react-i18next';
/**
 * API tokens card — shared between AdminPage (server admin console) and
 * TokensPage (per-user, /tokens). Tokens are per-USER: any signed-in user can
 * create/revoke their own tokens regardless of server role.
 * Per design/10-admin.html "API tokens" section.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ApiToken, Campaign } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import {
  compositionSafeFormSubmit,
  createCompositionSubmitGate,
} from '../../lib/compositionSafeSubmit';
import { joinPublicBase } from '../../lib/public-base';
import { Card, Btn, TextInput, Skeleton, EmptyState } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyControl } from '../../components/CopyControl';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { timeAgo, useTimeTick } from '../../lib/format';

type TokenScope = ApiToken['scope'];
type WriteScope = ApiToken['writeScope'];
type ApiTokenCreated = { token: string; apiToken: ApiToken };

const SCOPE_CHIP: Record<TokenScope, string> = {
  dm: 'cf-chip-dm',
  player: 'cf-chip-party',
  viewer: 'cf-chip-private',
};
const SCOPE_LABEL: Record<TokenScope, string> = { dm: 'DM', player: 'Player', viewer: 'Viewer' };
const SCOPE_HELP: Record<TokenScope, string> = {
  dm: 'Read scope: DM — can read everything (secrets, hidden context, full export) and approve proposals. Read scope only caps WHAT the token can see, not whether writes land.',
  player: 'Read scope: Player — scoped to that player; DM secrets are stripped.',
  viewer: 'Read scope: Viewer — read-only view; DM secrets are stripped.',
};

// Server-enforced WRITE authority, INDEPENDENT of read scope (issue #158).
// Read scope (DM/Player/Viewer) decides what the token can SEE; write mode
// below decides what the token can CHANGE and whether a human reviews first.
// Issue #575: the safe default for new tokens is "Propose" — AI changes land
// in the DM approval queue, never directly on canon.
const WRITE_SCOPE_LABEL: Record<WriteScope, string> = {
  direct: 'Direct write',
  propose: 'Propose (safe)',
  none: 'No writes',
};
const WRITE_SCOPE_HELP: Record<WriteScope, string> = {
  direct:
    'Direct — writes apply IMMEDIATELY to canon (characters, notes, dice, objectives, deletes…), subject only to the read scope above. NO human review. High blast radius: a misbehaving AI can rewrite or delete data before anyone notices. Choose this only for trusted, human-supervised integrations.',
  propose:
    'Propose (safe, RECOMMENDED for AI) — every write, including deletes, is forced into the DM proposal queue server-side, even if the AI omits the flag. Nothing touches canon until a DM clicks Approve. Reads are unaffected by this setting. Default for new tokens (issue #575).',
  none:
    'No writes — every write is rejected outright server-side (no proposal path, no canon changes, no queue). Use for purely read-only AI agents (summarization, lookup, analysis). Reads are unaffected.',
};

// Per-mode chip class for the existing-token row — surfaces blast radius at a
// glance: rose for direct (treat with caution), proposal-accent for the safe
// default, neutral for read-only.
const WRITE_SCOPE_CHIP: Record<WriteScope, string> = {
  direct: 'cf-chip-failed',
  propose: 'cf-chip-proposal',
  none: 'cf-chip-private',
};

function mcpConnectCommand(origin: string, token?: string): string {
  const authHeader = token ? `Bearer ${token}` : '<TOKEN>';
  return `claude mcp add --transport http campfire ${origin}/mcp --header "Authorization: ${authHeader}"`;
}

/**
 * "Connect your AI" block — always-visible tokenless version (persistent on /tokens)
 * unless `token` is supplied, in which case it shows the real command with the
 * one-time secret baked in (only ever rendered inside the just-created reveal).
 */
function ConnectAiBlock({ token }: { token?: string }) {
  const origin = window.location.origin;
  // The MCP JSON-RPC endpoint lives at /mcp inside Nest (root-excluded from the
  // /api/v1 prefix). Behind a reverse-proxy subpath the operator reaches it at
  // `${PUBLIC_BASE}/mcp`, so the connect command they hand an agent points at
  // the externally-visible URL (issue #798).
  const mcpUrl = `${origin}${joinPublicBase('/mcp')}`;
  const command = mcpConnectCommand(origin, token);
  const mcpId = useId();
  const commandId = useId();
  return (
    <div className="cf-inset p-3.5 space-y-2">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Connect your AI</p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-secondary">MCP endpoint</span>
        <code id={mcpId} className="text-xs text-slate-300 font-mono break-all flex-1 min-w-0">{mcpUrl}</code>
        <CopyControl density="xs" text={mcpUrl} selectTargetId={mcpId} className="text-xs" />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code id={commandId} className="cf-inset px-3 py-2 text-xs text-slate-300 font-mono break-all flex-1 min-w-0">
          {command}
        </code>
        <CopyControl density="xs" text={command} selectTargetId={commandId} className="text-xs" />
      </div>
      <p className="text-[11px] text-secondary">
        {token
          ? 'This command has your new token baked in — copy it now, it will not be shown again.'
          : 'Swap <TOKEN> for a token created above (or use the one-time command shown right after creating one).'}
      </p>
    </div>
  );
}

export function TokensCard() {
  useTimeTick();
  const { t } = useTranslation();
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
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
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
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white text-sm">
          API tokens <span className="text-secondary font-normal">(REST + MCP)</span>
        </h2>
        <Btn density="xs"
          className="text-xs"
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
        <EmptyState icon="key" title={t('admin.empty.noTokens')} hint={t('admin.empty.noTokensHint')} />
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
          confirmLabel="Revoke"
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
          <span className={`cf-chip ${SCOPE_CHIP[token.scope]} ml-1`}>{SCOPE_LABEL[token.scope]} read</span>{' '}
          <span className={`cf-chip ${WRITE_SCOPE_CHIP[token.writeScope]} ml-1`}>{WRITE_SCOPE_LABEL[token.writeScope]}</span>{' '}
          <span className="cf-chip cf-chip-private ml-1">{campaignBadge}</span>
        </p>
        <p className="text-[11px] text-secondary">
          {token.tokenPrefix}•••• · last used {token.lastUsedAt ? timeAgo(token.lastUsedAt) : 'never'}
        </p>
      </div>
      <Btn density="xs" ghost danger className="text-xs" onClick={onRevoke}>
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
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('player');
  // Safe default for new tokens (issue #575): AI changes land in the DM
  // proposal queue, never directly on canon. Admin opts into Direct explicitly.
  const [writeScope, setWriteScope] = useState<WriteScope>('propose');
  const [campaignId, setCampaignId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  // Issue #854: Enter confirming IME composition must not mint a token.
  const compositionGateRef = useRef<ReturnType<typeof createCompositionSubmitGate> | null>(null);
  if (compositionGateRef.current === null) {
    compositionGateRef.current = createCompositionSubmitGate();
  }
  const compositionGate = compositionGateRef.current;

  async function create() {
    if (saving || !name.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const result = await api.post<ApiTokenCreated>(`${API}/tokens`, {
        name: name.trim(),
        scope,
        writeScope,
        campaignId: campaignId ? Number(campaignId) : null,
      });
      onCreated(result);
    } catch (err) {
      onError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="cf-inset border-amber-500/30 p-3.5 space-y-2"
      onSubmit={compositionSafeFormSubmit(compositionGate, () => {
        void create();
      })}
    >
      <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">New token</p>
      <p className="text-[11px] text-slate-400">
        Two independent controls decide what an AI (or REST/MCP caller) can do
        with this token: <span className="text-slate-200 font-semibold">Read scope</span>{' '}
        caps what it can <em>see</em>; <span className="text-slate-200 font-semibold">Write mode</span>{' '}
        caps what it can <em>change</em> and whether a DM reviews first. Default
        is Propose — changes queue for DM approval and never touch canon
        directly.
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        <TextInput density="compact"
          className="text-sm"
          placeholder="Name, e.g. claude-scribe"
          aria-label="Token name (required)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...compositionGate.inputProps}
          autoFocus
        />
        <select
          className="cf-select text-sm cf-density-compact"
          value={scope}
          onChange={(e) => setScope(e.target.value as TokenScope)}
          aria-label="Read scope"
        >
          <option value="dm">Read: DM</option>
          <option value="player">Read: Player</option>
          <option value="viewer">Read: Viewer</option>
        </select>
        <select
          className="cf-select text-sm cf-density-compact"
          value={writeScope}
          onChange={(e) => setWriteScope(e.target.value as WriteScope)}
          aria-label="Write mode"
        >
          <option value="propose">Write: Propose (safe — recommended)</option>
          <option value="none">Write: No writes (read-only)</option>
          <option value="direct">Write: Direct (no review)</option>
        </select>
        <select
          className="cf-select text-sm cf-density-compact"
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          aria-label="Campaign binding"
        >
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-[11px] text-secondary">{SCOPE_HELP[scope]}</p>
      <p className="text-[11px] text-secondary">{WRITE_SCOPE_HELP[writeScope]}</p>
      {writeScope === 'direct' && (
        <p className="text-[11px] text-rose-400 font-semibold">
          ⚠ Direct writes apply immediately with no human review. Confirm this
          integration is trusted before minting.
        </p>
      )}
      <div className="flex items-center gap-2 justify-end">
        {!name.trim() && <p className="text-[11px] text-secondary mr-auto">Name your token to enable Create.</p>}
        <Btn density="xs" type="button" ghost className="text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn density="xs"
          type="submit"
          className="text-xs"
          disabled={saving || !name.trim()}
          title={!name.trim() ? 'Enter a token name first' : undefined}
        >
          Create
        </Btn>
      </div>
    </form>
  );
}

function NewTokenReveal({ created, onClose }: { created: ApiTokenCreated; onClose: () => void }) {
  // One-time secret: on clipboard failure CopyControl selects this node so the
  // token stays available for a manual copy instead of a false "Copied!".
  const tokenId = useId();

  return (
    <div className="cf-dm-panel p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
          <GameIcon slug="key" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />{created.apiToken.name} — shown once
        </p>
        <button type="button" className="text-[11px] text-secondary hover:text-white" onClick={onClose}>
          dismiss
        </button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code id={tokenId} className="cf-inset px-3 py-2 text-sm text-amber-300 font-mono break-all flex-1 min-w-0">
          {created.token}
        </code>
        <CopyControl density="xs"
          text={created.token}
          selectTargetId={tokenId}
          className="text-xs"
          successAnnouncement="Token copied to clipboard."
          failureAnnouncement="Copy failed. Clipboard blocked — select the token and copy it manually."
        />
      </div>
      <p className="text-[11px] text-slate-400">
        Shown once — save it somewhere safe, or use the ready-to-run command below.
      </p>
      <ConnectAiBlock token={created.token} />
    </div>
  );
}


