/**
 * "New campaign" wizard — full-screen overlay matching the design's dedicated
 * "New campaign" screen (design/claude-design/Campfire.dc.html ~117-180),
 * extended with a second step for rule-system selection per the BUILD spec:
 * step 1 (name/description) -> step 2 (pick an installed rule pack, or
 * "None / homebrew") -> POST /campaigns, then PATCH ruleSystem if one was
 * chosen. Rendered as an overlay rather than a route since Router/Layout are
 * orchestrator-owned; this keeps the flow reachable from the "+ New campaign"
 * tile on the hub without new route wiring.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { Campaign, RulePack } from '@campfire/schema';

type Step = 'details' | 'system';

export function NewCampaignWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ruleSystem, setRuleSystem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<RulePack[]>(`${API}/rules/packs`);
        if (!cancelled) setPacks(list);
      } catch (err) {
        if (!cancelled) {
          setPacks([]);
          setPacksError(err instanceof ApiError ? err.message : "Couldn't load rule systems.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function goToSystemStep(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give your campaign a name.');
      return;
    }
    setError(null);
    setStep('system');
  }

  async function createCampaign() {
    setSubmitting(true);
    setError(null);
    try {
      const campaign = await api.post<Campaign>(`${API}/campaigns`, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      if (ruleSystem) {
        try {
          await api.patch<Campaign>(`${API}/campaigns/${campaign.id}`, { ruleSystem });
        } catch {
          // Campaign exists even if the ruleSystem patch fails (e.g. backend not
          // wired up yet) — don't block the user from entering their new campaign.
        }
      }
      onCreated(campaign);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create campaign.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--color-bg)' }}
    >
      <header
        className="flex items-center gap-2.5"
        style={{ padding: '14px 22px', borderBottom: '1px solid var(--color-divider)' }}
      >
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onClose}>
          ← Campaigns
        </button>
      </header>
      <main
        className="w-full mx-auto flex flex-col gap-4"
        style={{ maxWidth: 560, padding: '28px 20px 48px' }}
      >
        <div>
          <h3 style={{ margin: 0 }}>New campaign</h3>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {step === 'details'
              ? "You'll be the DM. Invite players once it exists."
              : 'Pick the rule system this campaign runs on.'}
          </p>
        </div>

        {step === 'details' && (
          <form onSubmit={goToSystemStep} className="flex flex-col gap-4">
            <div className="card elev-sm">
              <div className="field">
                <label htmlFor="cname">Name</label>
                <input
                  id="cname"
                  className="input"
                  placeholder="e.g. The Salt Road"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="cdesc">
                  Description <span className="text-muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· optional</span>
                </label>
                <textarea
                  id="cdesc"
                  className="input"
                  style={{ minHeight: 60 }}
                  placeholder="One line for the campaign card"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
            {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
            <div className="flex gap-2 items-center">
              <button type="button" className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onClose}>
                Cancel
              </button>
              <div className="flex-1" />
              <button type="submit" className="btn btn-primary" style={{ minHeight: 42 }}>
                Next: rule system →
              </button>
            </div>
          </form>
        )}

        {step === 'system' && (
          <div className="flex flex-col gap-4">
            <div className="card elev-sm">
              <span className="card-kicker">Rule system</span>
              {packs === null ? (
                <p className="text-muted" style={{ fontSize: 13 }}>Loading installed rule systems…</p>
              ) : packs.length === 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-muted" style={{ fontSize: 12.5, margin: 0 }}>
                    {packsError ?? 'No rule systems are installed on this server yet.'}
                  </p>
                  <div
                    className="flex items-center gap-2.5"
                    style={{ padding: '10px 14px', border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', fontSize: 12 }}
                  >
                    <span className="text-muted">
                      A server admin can install one from{' '}
                      <Link to="/admin" style={{ color: 'var(--color-text)', textDecoration: 'underline' }}>
                        Server admin → Rule systems
                      </Link>
                      . You can still create this campaign and run it homebrew.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {packs.map((pack) => (
                    <button
                      key={pack.id}
                      type="button"
                      onClick={() => setRuleSystem(pack.slug)}
                      className="flex items-start gap-2.5 text-left"
                      style={{
                        padding: '11px 12px',
                        border: `1px solid ${ruleSystem === pack.slug ? 'var(--color-accent)' : 'var(--color-divider)'}`,
                        borderRadius: 'var(--radius-md)',
                        background: ruleSystem === pack.slug ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
                        font: 'inherit',
                        color: 'var(--color-text)',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        className="flex-none grid place-items-center"
                        style={{
                          width: 15,
                          height: 15,
                          marginTop: 1,
                          borderRadius: '50%',
                          border: `1.5px solid ${ruleSystem === pack.slug ? 'var(--color-accent)' : 'var(--color-divider)'}`,
                        }}
                      >
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: ruleSystem === pack.slug ? 'var(--color-accent)' : 'transparent',
                          }}
                        />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}>{pack.name}</span>
                        <span className="text-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
                          v{pack.version} · {pack.license} · {pack.entryCount} entries
                        </span>
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setRuleSystem(null)}
                    className="flex items-start gap-2.5 text-left"
                    style={{
                      padding: '11px 12px',
                      border: `1px solid ${ruleSystem === null ? 'var(--color-accent)' : 'var(--color-divider)'}`,
                      borderRadius: 'var(--radius-md)',
                      background: ruleSystem === null ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
                      font: 'inherit',
                      color: 'var(--color-text)',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      className="flex-none grid place-items-center"
                      style={{
                        width: 15,
                        height: 15,
                        marginTop: 1,
                        borderRadius: '50%',
                        border: `1.5px solid ${ruleSystem === null ? 'var(--color-accent)' : 'var(--color-divider)'}`,
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: ruleSystem === null ? 'var(--color-accent)' : 'transparent',
                        }}
                      />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13.5 }}>None / homebrew</span>
                      <span className="text-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
                        No installed rules text — sheets, dice and notes still work.
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
            {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
            <div className="flex gap-2 items-center">
              <button type="button" className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setStep('details')}>
                ← Back
              </button>
              <div className="flex-1" />
              <button
                type="button"
                className="btn btn-primary"
                style={{ minHeight: 42 }}
                disabled={submitting}
                onClick={createCampaign}
              >
                {submitting ? 'Creating…' : 'Create campaign'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
