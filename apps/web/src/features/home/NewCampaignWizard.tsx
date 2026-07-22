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
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { Campaign, RulePack } from '@campfire/schema';
import { mechanicsForPackSlug } from '../../lib/rules';
import { useAuth } from '../../app/auth';
import { adminRulesHref, NEW_CAMPAIGN_SETUP_PATH } from '../../lib/adminNavigation';
import { useDialog } from '../../components/useDialog';

type Step = 'details' | 'system';

export function NewCampaignWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (campaign: Campaign) => void | Promise<void>;
}) {
  const { isAdmin } = useAuth();
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ruleSystem, setRuleSystem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const systemHeadingRef = useRef<HTMLHeadingElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const previousStepRef = useRef<Step>(step);
  const dirty = name.length > 0 || description.length > 0 || step !== 'details' || ruleSystem !== null;

  function keepEditing() {
    setConfirmDiscard(false);
    requestAnimationFrame(() => {
      if (step === 'system') systemHeadingRef.current?.focus();
      else nameRef.current?.focus();
    });
  }

  function requestClose() {
    if (confirmDiscard) {
      keepEditing();
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    setConfirmDiscard(true);
  }

  const dialogRef = useDialog<HTMLDivElement>({
    onClose: requestClose,
    disabled: submitting,
    initialFocusRef: nameRef,
    inertBackground: true,
  });

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    if (step === 'system') systemHeadingRef.current?.focus();
    else nameRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

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
      // Awaited so the button stays in its "Creating…" state while the parent
      // refreshes memberships/campaigns before navigating (issue #103) — no
      // flash back to the idle label mid-transition.
      await onCreated(campaign);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create campaign.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain"
      style={{ background: 'var(--color-bg)' }}
      role={confirmDiscard ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-label={confirmDiscard ? undefined : 'New campaign'}
      aria-labelledby={confirmDiscard ? 'discard-campaign-title' : undefined}
      aria-describedby={confirmDiscard ? 'discard-campaign-description' : undefined}
      aria-busy={submitting || undefined}
    >
      {confirmDiscard ? (
        <div className="w-full max-w-md m-auto px-4 py-8">
          <div className="card elev-md" style={{ gap: 16, padding: 20 }}>
            <div>
              <h3 id="discard-campaign-title" style={{ margin: 0 }}>Discard new campaign?</h3>
              <p id="discard-campaign-description" className="text-muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
                Your campaign details and rule-system choice have not been saved.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button ref={keepEditingRef} type="button" className="btn btn-secondary" style={{ minHeight: 44 }} onClick={keepEditing}>
                Keep editing
              </button>
              <button type="button" className="btn btn-secondary" style={{ minHeight: 44, color: '#f87171' }} onClick={onClose}>
                Discard campaign
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <header
            className="sticky top-0 z-10 flex items-center gap-2.5"
            style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-divider)', background: 'var(--color-bg)' }}
          >
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 13, minHeight: 44 }}
              onClick={requestClose}
              disabled={submitting}
              aria-label={dirty ? 'Discard campaign and return to campaigns' : 'Cancel and return to campaigns'}
            >
              ← Campaigns
            </button>
          </header>
          <div
            className="w-full mx-auto flex flex-col gap-4 px-4 py-5 sm:px-5 sm:pt-7 sm:pb-12"
            style={{ maxWidth: 560 }}
          >
        <div>
          <h3 style={{ margin: 0 }}>New campaign</h3>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {step === 'details'
              ? "You'll be the DM. Invite players once it exists."
              : 'Pick the rule system this campaign runs on.'}
          </p>
        </div>

        <div>
          <ol
            aria-label="Campaign setup progress"
            className="flex flex-wrap items-center gap-2 list-none m-0 p-0"
            style={{ fontSize: 12.5 }}
          >
            <li
              className="flex items-center gap-1.5"
              aria-current={step === 'details' ? 'step' : undefined}
              style={{ color: step === 'details' ? 'var(--color-accent)' : 'var(--color-neutral-400)', fontWeight: step === 'details' ? 700 : 400 }}
            >
              <span aria-hidden="true" className="grid place-items-center rounded-full" style={{ width: 22, height: 22, border: '1px solid currentColor' }}>1</span>
              Details
            </li>
            <li aria-hidden="true" className="text-muted">·</li>
            <li
              className="flex items-center gap-1.5"
              aria-current={step === 'system' ? 'step' : undefined}
              style={{ color: step === 'system' ? 'var(--color-accent)' : 'var(--color-neutral-400)', fontWeight: step === 'system' ? 700 : 400 }}
            >
              <span aria-hidden="true" className="grid place-items-center rounded-full" style={{ width: 22, height: 22, border: '1px solid currentColor' }}>2</span>
              Rule system
            </li>
          </ol>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Step {step === 'details' ? '1' : '2'} of 2: {step === 'details' ? 'Details' : 'Rule system'}
          </p>
        </div>

        {step === 'details' && (
          <form onSubmit={goToSystemStep} className="flex flex-col gap-4">
            <div className="card elev-sm">
              <div className="field">
                <label htmlFor="cname">Name</label>
                <input
                  ref={nameRef}
                  id="cname"
                  className="input"
                  style={{ minHeight: 44 }}
                  placeholder="e.g. The Salt Road"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
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
                  style={{ minHeight: 88 }}
                  placeholder="One line for the campaign card"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
            {error && <p role="alert" className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
            <div className="flex flex-wrap gap-2 items-center justify-between">
              <button type="button" className="btn btn-ghost" style={{ fontSize: 13, minHeight: 44 }} onClick={requestClose}>
                {dirty ? 'Discard campaign' : 'Cancel'}
              </button>
              <button type="submit" className="btn btn-primary" style={{ minHeight: 44 }}>
                Next: rule system →
              </button>
            </div>
          </form>
        )}

        {step === 'system' && (
          <div className="flex flex-col gap-4">
            <div className="card elev-sm">
              <h4 ref={systemHeadingRef} tabIndex={-1} className="card-kicker" style={{ margin: 0 }}>Rule system</h4>
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
                      {isAdmin ? (
                        <>
                          Install one from{' '}
                          <Link
                            to={adminRulesHref(NEW_CAMPAIGN_SETUP_PATH)}
                            style={{ color: 'var(--color-text)', textDecoration: 'underline' }}
                          >
                            Server admin → Rule systems
                          </Link>
                        </>
                      ) : (
                        <>Ask a server admin to install a rule system</>
                      )}
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
                      aria-pressed={ruleSystem === pack.slug}
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
                        {mechanicsForPackSlug(pack.slug) && (
                          <span className="text-muted" style={{ display: 'block', fontSize: 11, marginTop: 2, opacity: 0.85 }}>
                            {mechanicsForPackSlug(pack.slug)}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setRuleSystem(null)}
                    aria-pressed={ruleSystem === null}
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
            {error && <p role="alert" className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
            <div className="flex flex-wrap gap-2 items-center justify-between">
              <button type="button" className="btn btn-ghost" style={{ fontSize: 13, minHeight: 44 }} onClick={() => setStep('details')}>
                ← Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ minHeight: 44 }}
                disabled={submitting}
                onClick={createCampaign}
              >
                {submitting ? 'Creating…' : 'Create campaign'}
              </button>
            </div>
          </div>
        )}
          </div>
        </>
      )}
    </div>
  );
}
