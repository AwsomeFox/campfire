/**
 * "New campaign" wizard — full-screen overlay matching the design's dedicated
 * "New campaign" screen (design/claude-design/Campfire.dc.html ~117-180),
 * extended with a second step for rule-system selection per the BUILD spec:
 * step 1 (name/description) -> step 2 (pick an installed rule pack, or
 * "None / homebrew") -> POST /campaigns with ruleSystem when selected (issue #539).
 * Rendered as an overlay rather than a route since Router/Layout are
 * orchestrator-owned; this keeps the flow reachable from the "+ New campaign"
 * tile on the hub without new route wiring.
 */
import { Card } from '../../components/ui';
import { forwardRef, useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import type { Campaign, RulePack } from '@campfire/schema';
import {
  capabilityStatusLabel,
  mechanicsForPackSlug,
  rulesetCapabilitiesForSelection,
  type RulesetCapabilityProfile,
} from '../../lib/rules';
import { useAuth } from '../../app/auth';
import { adminRulesHref, NEW_CAMPAIGN_SETUP_PATH } from '../../lib/adminNavigation';
import { useAnnounce } from '../../components/Announcer';

type Step = 'details' | 'system';

const STEP_TITLES: Record<Step, string> = {
  details: 'Campaign details',
  system: 'Rule system',
};

const DEFAULT_DOCUMENT_TITLE = 'Campfire';
const HOMEBREW_RULE_SYSTEM_KEY = '__homebrew__';

function ruleSystemChoiceKey(value: string | null) {
  return value ?? HOMEBREW_RULE_SYSTEM_KEY;
}

export function NewCampaignWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (campaign: Campaign) => void | Promise<void>;
}) {
  const { isAdmin } = useAuth();
  const announce = useAnnounce();
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ruleSystem, setRuleSystem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [packs, setPacks] = useState<RulePack[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);

  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const prevStepRef = useRef<Step | null>(null);
  const ruleSystemChoiceRefs = useRef<Record<string, HTMLButtonElement | null>>({});

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

  useEffect(() => {
    const previousTitle = document.title;
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    const stepTitle = STEP_TITLES[step];
    document.title = `New campaign — ${stepTitle} · ${DEFAULT_DOCUMENT_TITLE}`;
  }, [step]);

  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = step;
    const id = window.requestAnimationFrame(() => {
      stepHeadingRef.current?.focus({ preventScroll: true });
    });
    if (prev !== null && prev !== step) {
      announce(`${STEP_TITLES[step]}.`);
    }
    return () => window.cancelAnimationFrame(id);
  }, [step, announce]);

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
        ...(ruleSystem ? { ruleSystem } : {}),
      });
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

  const selectedProfile =
    packs === null ? null : rulesetCapabilitiesForSelection(ruleSystem, packs);
  const basePacks = packs?.filter((pack) => pack.kind === 'base') ?? null;

  const focusRuleSystemChoice = useCallback((value: string | null) => {
    ruleSystemChoiceRefs.current[ruleSystemChoiceKey(value)]?.focus();
  }, []);

  function onRuleSystemChoiceKeyDown(e: KeyboardEvent<HTMLButtonElement>, value: string | null) {
    if (basePacks === null) return;

    const optionValues: Array<string | null> = [...basePacks.map((pack) => pack.slug), null];
    const idx = optionValues.indexOf(value);
    if (idx === -1) return;

    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % optionValues.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + optionValues.length) % optionValues.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = optionValues.length - 1;
    if (nextIdx == null) return;

    e.preventDefault();
    const next = optionValues[nextIdx]!;
    setRuleSystem(next);
    focusRuleSystemChoice(next);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--color-bg)', overflowY: 'auto' }}
    >
      <header
        className="flex items-center gap-2.5"
        style={{ padding: '14px 22px', borderBottom: '1px solid var(--color-divider)' }}
      >
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onClose}>
          ← Campaigns
        </button>
      </header>
      <section
        className="w-full mx-auto flex flex-col gap-4"
        style={{ maxWidth: 560, padding: '28px 20px 48px' }}
        aria-labelledby="new-campaign-title"
      >
        <div>
          <h1 id="new-campaign-title" style={{ margin: 0 }}>
            New campaign
          </h1>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {step === 'details'
              ? "You'll be the DM. Invite players once it exists."
              : 'Pick the rule system this campaign runs on.'}
          </p>
        </div>

        {step === 'details' && (
          <form onSubmit={goToSystemStep} className="flex flex-col gap-4" aria-labelledby="new-campaign-step-title">
            <h2
              id="new-campaign-step-title"
              ref={stepHeadingRef}
              tabIndex={-1}
              style={{ margin: 0, fontSize: 'inherit', fontWeight: 600 }}
            >
              {STEP_TITLES.details}
            </h2>
            <Card density="compact" elev="sm">
              <div className="field">
                <label htmlFor="cname">Name</label>
                <input
                  id="cname"
                  className="input"
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
                  style={{ minHeight: 60 }}
                  placeholder="One line for the campaign card"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </Card>
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
          <div className="flex flex-col gap-4" aria-labelledby="new-campaign-step-title">
            <h2
              id="new-campaign-step-title"
              ref={stepHeadingRef}
              tabIndex={-1}
              style={{ margin: 0, fontSize: 'inherit', fontWeight: 600 }}
            >
              {STEP_TITLES.system}
            </h2>
            <Card density="compact" elev="sm">
              {packs === null ? (
                <p className="text-muted" style={{ fontSize: 13 }}>Loading installed rule systems…</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {basePacks?.length === 0 && (
                    <EmptyRulePacksNotice isAdmin={isAdmin} packsError={packsError} />
                  )}
                  <div className="flex flex-col gap-2" role="radiogroup" aria-label="Installed rule systems">
                    {basePacks?.map((pack) => (
                      <RuleSystemChoice
                        key={pack.id}
                        ref={(el) => {
                          ruleSystemChoiceRefs.current[ruleSystemChoiceKey(pack.slug)] = el;
                        }}
                        selected={ruleSystem === pack.slug}
                        onSelect={() => setRuleSystem(pack.slug)}
                        onKeyDown={(e) => onRuleSystemChoiceKeyDown(e, pack.slug)}
                        title={pack.name}
                        meta={`v${pack.version} · ${pack.license} · ${pack.entryCount} entries`}
                        description={mechanicsForPackSlug(pack.slug)}
                      />
                    ))}
                    <RuleSystemChoice
                      ref={(el) => {
                        ruleSystemChoiceRefs.current[ruleSystemChoiceKey(null)] = el;
                      }}
                      selected={ruleSystem === null}
                      onSelect={() => setRuleSystem(null)}
                      onKeyDown={(e) => onRuleSystemChoiceKeyDown(e, null)}
                      title="None / homebrew"
                      meta="No installed compendium or rules text"
                      description="Sheets, dice and notes still work; combat and difficulty use disclosed fallback behavior."
                    />
                  </div>
                  {selectedProfile && (
                    <RulesetCapabilityDisclosure
                      profile={selectedProfile}
                      comparingAgainstInstalledPack={selectedProfile.isHomebrew && packs.length > 0}
                    />
                  )}
                </div>
              )}
            </Card>
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
      </section>
    </div>
  );
}

const RuleSystemChoice = forwardRef<HTMLButtonElement, {
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  title: string;
  meta: string;
  description?: string;
}>(function RuleSystemChoice({
  selected,
  onSelect,
  onKeyDown,
  title,
  meta,
  description,
}, ref) {
  const titleId = useId();
  const metaId = useId();
  const descriptionId = useId();

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-labelledby={titleId}
      aria-describedby={description ? `${metaId} ${descriptionId}` : metaId}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className="flex items-start gap-2.5 text-left"
      style={{
        padding: '11px 12px',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-divider)'}`,
        borderRadius: 'var(--radius-md)',
        background: selected ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
        font: 'inherit',
        color: 'var(--color-text)',
        cursor: 'pointer',
      }}
    >
      <span
        className="flex-none grid place-items-center"
        aria-hidden="true"
        style={{
          width: 15,
          height: 15,
          marginTop: 1,
          borderRadius: '50%',
          border: `1.5px solid ${selected ? 'var(--color-accent)' : 'var(--color-divider)'}`,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: selected ? 'var(--color-accent)' : 'transparent',
          }}
        />
      </span>
      <span style={{ minWidth: 0 }}>
        <span id={titleId} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}>
          {title}
        </span>
        <span id={metaId} className="text-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
          {meta}
        </span>
        {description && (
          <span id={descriptionId} className="text-muted" style={{ display: 'block', fontSize: 11, marginTop: 2, opacity: 0.85 }}>
            {description}
          </span>
        )}
      </span>
    </button>
  );
});

function EmptyRulePacksNotice({
  isAdmin,
  packsError,
}: {
  isAdmin: boolean;
  packsError: string | null;
}) {
  return (
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
              , then return here, or choose None / homebrew below.
            </>
          ) : (
            <>
              Ask a server admin to install a rule system from Server admin → Rule systems.
              Suggested request: "Please install the rules pack for this campaign, then I can select it during setup."
              You can still choose None / homebrew below.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function RulesetCapabilityDisclosure({
  profile,
  comparingAgainstInstalledPack,
}: {
  profile: RulesetCapabilityProfile;
  comparingAgainstInstalledPack: boolean;
}) {
  return (
    <section
      aria-labelledby="ruleset-capability-heading"
      className="flex flex-col gap-2"
      style={{
        border: '1px solid var(--color-divider)',
        borderRadius: 'var(--radius-md)',
        padding: '12px',
        fontSize: 11.5,
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 id="ruleset-capability-heading" style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>
          {profile.isHomebrew ? 'Before you create with None / homebrew' : `Before you create with ${profile.name}`}
        </h3>
        <p className="text-muted" style={{ margin: 0 }}>
          {profile.mechanicsSummary}
        </p>
        {comparingAgainstInstalledPack && (
          <p className="text-muted" style={{ margin: 0 }}>
            Compared with selecting an installed pack, these capabilities are missing, limited, or using fallbacks:
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {profile.capabilities.map((capability) => (
          <li
            key={capability.key}
            className="flex gap-2"
            style={{
              borderTop: '1px solid color-mix(in srgb, var(--color-divider) 70%, transparent)',
              paddingTop: 6,
            }}
          >
            <span
              className="tag tag-neutral"
              style={{ fontSize: 10, height: 'fit-content', minWidth: 72, justifyContent: 'center' }}
            >
              {capabilityStatusLabel(capability.status)}
            </span>
            <span>
              <strong style={{ color: 'var(--color-text)' }}>{capability.label}:</strong>{' '}
              <span className="text-muted">{capability.summary}</span>
            </span>
          </li>
        ))}
      </ul>

      <div
        style={{
          borderTop: '1px solid color-mix(in srgb, var(--color-divider) 70%, transparent)',
          paddingTop: 8,
        }}
      >
        <p style={{ margin: '0 0 4px', color: 'var(--color-text)', fontWeight: 600 }}>
          Change later in Settings
        </p>
        <ul className="text-muted" style={{ margin: 0, paddingLeft: '1rem' }}>
          {profile.migrationPreview.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
