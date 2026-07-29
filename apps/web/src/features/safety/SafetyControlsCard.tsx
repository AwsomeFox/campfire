import { useCallback, useEffect, useState } from 'react';
import type { CampaignMember, SafetyControl } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { Card, Btn, ErrorNote, Skeleton } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';

/**
 * Personal safety controls (issue #597) — blocks and mutes owned by the signed-in
 * member.
 *
 * Every member sees this card, including a DM, because these are personal settings
 * rather than table administration. A DM cannot see anybody else's: the server refuses
 * to serve them, and the reason is the same one that keeps a block quiet on the sender's
 * side — the fewer people who know who blocked whom, the fewer ways it can be relayed
 * back to the person it protects against.
 *
 * The copy here is deliberate about the difference between the two controls, because
 * choosing the wrong one is a safety failure and "mute" reads as stronger than it is:
 * a MUTE only stops notifications, while a BLOCK stops the person reaching you at all
 * and hides what they have already sent.
 */
export function SafetyControlsCard({
  campaignId,
  members,
  myUserId,
}: {
  campaignId: number;
  members: CampaignMember[];
  myUserId: number | null;
}) {
  const announce = useAnnounce();
  const [controls, setControls] = useState<SafetyControl[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<SafetyControl[]>(`${API}/campaigns/${campaignId}/safety/controls`);
      setControls(rows);
      setError(null);
    } catch {
      setError('Could not load your blocks and mutes.');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const blockable = members.filter(
    (m) => myUserId != null && m.userId !== myUserId && !controls?.some((c) => c.targetUserId === String(m.userId)),
  );

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      announce(message);
      await load();
    } catch {
      setError('That change could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const blocks = controls?.filter((c) => c.kind === 'block') ?? [];
  const mutes = controls?.filter((c) => c.kind !== 'block') ?? [];

  return (
    <Card className="space-y-2.5" data-testid="safety-controls-card">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2 m-0">Blocks and mutes</h2>
      <p className="text-muted text-[11px] m-0">
        These are yours alone. Nobody else can see them — not other members, and not your DM. The person you block
        is never told, and their messages keep appearing to succeed on their side; they simply never reach you.
      </p>

      {error && <ErrorNote message={error} onRetry={load} />}
      {loading && !controls ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <div className="space-y-1.5">
            <h3 className="text-[12px] font-semibold text-white m-0">Blocked</h3>
            {blocks.length === 0 ? (
              <p className="text-muted text-[11px] m-0">You haven&rsquo;t blocked anyone.</p>
            ) : (
              blocks.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[12px]">
                  <span className="flex-1 min-w-0 truncate">{c.targetName || c.targetUserId}</span>
                  <span className="text-muted text-[10px]">all campaigns</span>
                  <button
                    type="button"
                    className="text-[11px] text-secondary hover:text-white"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api.delete(`${API}/campaigns/${campaignId}/safety/controls/${c.id}`),
                        `Unblocked ${c.targetName || c.targetUserId}.`,
                      )
                    }
                  >
                    Unblock
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-1.5">
            <h3 className="text-[12px] font-semibold text-white m-0">Muted</h3>
            <p className="text-muted text-[10px] m-0">
              A mute only stops notifications. Their posts stay visible, and anything they already sent you stays in
              your inbox.
            </p>
            {mutes.length === 0 ? (
              <p className="text-muted text-[11px] m-0">Nothing muted.</p>
            ) : (
              mutes.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[12px]">
                  <span className="flex-1 min-w-0 truncate">
                    {c.kind === 'mute_sender'
                      ? c.targetName || c.targetUserId
                      : `${c.threadEntityType ?? 'thread'} #${c.threadEntityId ?? '?'}`}
                  </span>
                  <button
                    type="button"
                    className="text-[11px] text-secondary hover:text-white"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api.delete(`${API}/campaigns/${campaignId}/safety/controls/${c.id}`),
                        'Mute lifted.',
                      )
                    }
                  >
                    Unmute
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <select
              className="cf-select text-xs flex-1 cf-density-xs"
              value={target}
              aria-label="Member to block or mute"
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose a member…</option>
              {blockable.map((m) => (
                <option key={m.id} value={String(m.userId)}>
                  {m.displayName || m.username}
                </option>
              ))}
            </select>
            <Btn
              ghost
              disabled={!target || busy}
              onClick={() =>
                void act(
                  () => api.post(`${API}/campaigns/${campaignId}/safety/mutes`, { targetUserId: target }),
                  'Muted.',
                ).then(() => setTarget(''))
              }
            >
              Mute
            </Btn>
            <Btn
              danger
              disabled={!target || busy}
              onClick={() =>
                void act(
                  () => api.post(`${API}/campaigns/${campaignId}/safety/blocks`, { targetUserId: target }),
                  'Blocked.',
                ).then(() => setTarget(''))
              }
            >
              Block
            </Btn>
          </div>
        </>
      )}
    </Card>
  );
}
