import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { RULE_PACK_SOURCE_META, RulePackInstallSource } from '@campfire/schema';
import {
  OPEN5E_DEFAULT_BASE_URL,
  OPEN5E_SECTION_TO_PATH,
  ALL_OPEN5E_SECTIONS,
  fetchOpen5eSection,
  entryTypeForSection as open5eEntryType,
} from '../src/modules/rules/open5e-importer';
import {
  OPEN_LEGEND_DEFAULT_BASE_URL,
  OPEN_LEGEND_SECTION_TO_PATH,
  ALL_OPEN_LEGEND_SECTIONS,
  fetchOpenLegendSection,
  entryTypeForOpenLegendSection,
} from '../src/modules/rules/open-legend-importer';
import {
  PF2E_DEFAULT_BASE_URL,
  PF2E_INDEX,
  SF2E_DEFAULT_BASE_URL,
  SF2E_INDEX,
  fetchPf2eSection,
  fetchSf2eSection,
  entryTypeForSection as pf2eEntryType,
} from '../src/modules/rules/pf2e-importer';
import {
  CEPHEUS_DEFAULT_BASE_URL,
  CEPHEUS_CHAPTERS,
  fetchCepheusSection,
  entryTypeForCepheusSection,
} from '../src/modules/rules/cepheus-importer';
import {
  DATASWORN_STARFORGED_URL,
  fetchDataswornDocument,
  mapDataswornSection,
  entryTypeForDataswornSection,
} from '../src/modules/rules/datasworn-importer';
import { STARFINDER_DEFAULT_BASE_URL } from '../src/modules/rules/starfinder-importer';
import { ARCHMAGE_DEFAULT_BASE_URL } from '../src/modules/rules/archmage-importer';
import { PF1E_DEFAULT_BASE_URL } from '../src/modules/rules/pathfinder1e-importer';

/**
 * Live rule-source smoke tests (issue #568).
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE. Every rule-pack importer talks to a third-party
 * upstream that Campfire does not control. The unit/e2e suites all run against the fake
 * servers in `test/fake-*.ts`, so they prove the importer handles the shape it was WRITTEN
 * for — they can never notice that the real upstream stopped serving that shape. Before this
 * file, only `open-legend` had any live check at all (rules.e2e-spec.ts, `describe.skip`
 * unless RUN_LIVE_RULES_SMOKE=1, which no workflow ever set), so an Open5e v3, a renamed
 * Archives-of-Nethys index, or a moved raw-GitHub path would have shipped a broken install
 * button and nothing would have failed until a DM hit it.
 *
 * TWO LAYERS, DELIBERATELY:
 *
 *  1. COVERAGE GUARDS — always run, no network. They derive the list of importers from the
 *     filesystem (`src/modules/rules/*-importer.ts`) and the list of install sources from the
 *     shared `RulePackInstallSource` enum, then assert every one is claimed by a probe below.
 *     A hand-maintained parallel list of sources in a test would rot the first time someone
 *     adds an importer and forgets the test — which is precisely the drift #568 is about — so
 *     adding an importer (or a new `*_DEFAULT_BASE_URL`) without a probe FAILS in normal CI,
 *     offline, immediately. That is what makes a new importer "automatically covered".
 *
 *  2. LIVE PROBES — gated on RUN_LIVE_RULES_SMOKE=1 so a developer's `npm test` never hits
 *     the network, and run nightly by .github/workflows/rules-live-smoke.yml. Deliberately
 *     NOT in .github/workflows/ci.yml: a network-dependent test in the PR gate would make CI
 *     flaky for every unrelated PR, which is worse than the problem being solved.
 *
 * WHAT A LIVE PROBE ASSERTS (an HTTP 200 is NOT enough — a 200 serving an SPA's HTML error
 * page is exactly how `/v2/races/` broke, see the open5e-importer header):
 *   - the URL resolves (no 404/5xx),
 *   - the body is not HTML,
 *   - for JSON sources, the body parses as JSON and carries the container field the importer
 *     reads (`results` / `hits.hits`),
 *   - a representative section survives the importer's OWN fetch+map path, producing a
 *     plausible number of entries whose name/slug/type/body/license are actually populated —
 *     a renamed upstream field yields entries with empty bodies, which `minBodyRatio` catches.
 *
 * Every probe reads its URL and paths from the importer's own exported constants, so the
 * smoke always probes what the importer really requests.
 */

const RULES_SRC_DIR = path.resolve(__dirname, '..', 'src', 'modules', 'rules');

/** Only run the network-touching describes when explicitly opted in (see file header). */
const liveSmoke = process.env.RUN_LIVE_RULES_SMOKE === '1' ? describe : describe.skip;

/** Live fetches of whole sections are slow (large upstreams, retries); give them real room. */
const LIVE_TIMEOUT_MS = 180_000;

/** A quiet logger so a probe's per-section import summary doesn't drown the test output. */
const quietLogger = { warn: () => {}, info: () => {} };

/**
 * The subset of every importer's `ImportedEntry` the smoke asserts on. Declared structurally
 * rather than importing one importer's interface so a probe can return any importer's result
 * type (Open Legend's `OlImportedEntry`, Open5e's `ImportedEntry`, …) without a cast.
 */
interface SmokeEntry {
  slug: string;
  name: string;
  type: string;
  body: string;
  license: string;
  /** Optional so a probe can return any importer's entry type without widening them all. */
  dataJson?: string | null;
}

interface ProbeSectionResult {
  entries: SmokeEntry[];
  /** Optional so a probe can return any importer's result type; only the AoN probes read it. */
  truncated?: boolean;
}

/**
 * A second, cheap section fetched purely to prove the MECHANICAL fields still land.
 *
 * The prose checks above (`minBodyRatio`) cannot see this class of drift: an upstream that
 * renames `price_raw`, or starts serving `size` as a bare string instead of a one-element
 * array, still returns full prose for every row. The importer keeps producing entries that
 * look healthy and are quietly missing their stats — which is exactly how PF2e/SF2e items
 * shipped for months with no price, range, or weapon block at all while this file was green
 * (its only AoN probe was `conditions`, which is prose and carries no mechanics).
 */
interface FactProbe {
  section: string;
  /** Each key must appear in `dataJson` on at least `minRatio` of the section's entries. */
  requiredFactKeys: string[];
  minRatio: number;
  run: () => Promise<ProbeSectionResult>;
}

/**
 * A raw URL the importer really requests, checked before the mapping layer so a failure can
 * name the exact URL that drifted rather than surfacing as "0 entries imported".
 */
interface RawUrlCheck {
  /** Human label for the failure message, e.g. the section name. */
  label: string;
  url: string;
  /** `json` also asserts the parsed body carries `container` (dotted path). */
  format: 'json' | 'text';
  /** Dotted path that must resolve to a non-empty array, e.g. 'results' or 'hits.hits'. */
  container?: string;
}

interface BaseProbe {
  /** Importer module basename under src/modules/rules (used by the coverage guard). */
  module: string;
  /** Install source(s) from RulePackInstallSource this importer serves. */
  sources: RulePackInstallSource[];
  /**
   * Name of the exported `*_DEFAULT_BASE_URL` constant this probe claims, or null when the
   * importer intentionally exports none (it has no built-in source at all).
   */
  constName: string | null;
  /** The constant's value, imported — never re-typed here, so it can't drift from the source. */
  baseUrl: string;
}

/** An importer with a wired, working default source: must survive a real fetch + map. */
interface LiveProbe extends BaseProbe {
  kind: 'live';
  /** Small, representative section fetched live (kept cheap — not the 3k-row ones). */
  section: string;
  /** The rule-entry type the importer declares for `section`; mapped entries must match. */
  expectedEntryType: string;
  /** Floor for entries the section must yield; well under the real count, over zero. */
  minEntries: number;
  /** Fraction of entries whose `body` must be non-empty (catches a renamed prose field). */
  minBodyRatio: number;
  rawChecks: RawUrlCheck[];
  run: () => Promise<ProbeSectionResult>;
  /** Optional mechanical-field probe; see {@link FactProbe} for why prose alone isn't enough. */
  facts?: FactProbe;
}

/**
 * An importer with NO validated open first-party source (`sourceKind: 'manual-upload'`, see
 * RULE_PACK_SOURCE_META). There is nothing live to smoke; what must hold is that the default
 * install path is REJECTED before any fetch — the #555 contract. Probed offline.
 */
interface ManualUploadProbe extends BaseProbe {
  kind: 'manual-upload';
}

type RuleSourceProbe = LiveProbe | ManualUploadProbe;

/**
 * The probe registry. One entry per `*-importer.ts`; the coverage guards below prove it is
 * exhaustive against BOTH the filesystem and the shared install-source enum.
 */
const RULE_SOURCE_PROBES: RuleSourceProbe[] = [
  {
    kind: 'live',
    module: 'open5e-importer',
    // 'other' is documented as a straight alias for the Open5e importer (RULE_PACK_SOURCE_META).
    sources: ['open5e', 'other'],
    constName: 'OPEN5E_DEFAULT_BASE_URL',
    baseUrl: OPEN5E_DEFAULT_BASE_URL,
    section: 'conditions',
    expectedEntryType: open5eEntryType('conditions'),
    // The SRD has 21 conditions; a floor of 10 tolerates upstream curation but not a wipe.
    minEntries: 10,
    minBodyRatio: 0.8,
    // EVERY section path is probed, not just the fetched one: the `/v2/monsters/` →
    // `/v2/creatures/` and `/v2/races/` → `/v2/species/` moves in the importer header are the
    // canonical drift here, and both showed up as a path that stopped returning JSON.
    rawChecks: ALL_OPEN5E_SECTIONS.map((section) => ({
      label: `section "${section}"`,
      url: `${OPEN5E_DEFAULT_BASE_URL.replace(/\/$/, '')}/${OPEN5E_SECTION_TO_PATH[section]}/?limit=1`,
      format: 'json' as const,
      container: 'results',
    })),
    run: () => fetchOpen5eSection(OPEN5E_DEFAULT_BASE_URL, 'conditions', quietLogger),
  },
  {
    kind: 'live',
    module: 'open-legend-importer',
    sources: ['open-legend'],
    constName: 'OPEN_LEGEND_DEFAULT_BASE_URL',
    baseUrl: OPEN_LEGEND_DEFAULT_BASE_URL,
    section: 'banes',
    expectedEntryType: entryTypeForOpenLegendSection('banes'),
    minEntries: 10, // the repo ships 25+ banes
    minBodyRatio: 0.8,
    // YAML, not JSON — so the raw check only proves each data file resolves and is not an
    // HTML error page; the importer's own YAML parse is exercised by `run` below.
    rawChecks: ALL_OPEN_LEGEND_SECTIONS.map((section) => ({
      label: `section "${section}"`,
      url: `${OPEN_LEGEND_DEFAULT_BASE_URL.replace(/\/$/, '')}/${OPEN_LEGEND_SECTION_TO_PATH[section]}`,
      format: 'text' as const,
    })),
    run: () => fetchOpenLegendSection(OPEN_LEGEND_DEFAULT_BASE_URL, 'banes', quietLogger),
  },
  {
    kind: 'live',
    module: 'pf2e-importer',
    // One module, two indices: pf2e ('aon') and sf2e ('aonsf'). Both get their own probe so a
    // failure names the index that drifted; the coverage guard accepts either claiming the file.
    sources: ['pf2e'],
    constName: 'PF2E_DEFAULT_BASE_URL',
    baseUrl: PF2E_DEFAULT_BASE_URL,
    section: 'conditions',
    expectedEntryType: pf2eEntryType('conditions'),
    minEntries: 10,
    minBodyRatio: 0.5, // AoN condition rows carry prose in `text`; some are terse cross-refs
    rawChecks: [
      {
        label: `index "${PF2E_INDEX}" type:condition`,
        url: `${PF2E_DEFAULT_BASE_URL.replace(/\/$/, '')}/${PF2E_INDEX}/_search?q=${encodeURIComponent('type:condition')}&size=1`,
        format: 'json',
        container: 'hits.hits',
      },
    ],
    run: () => fetchPf2eSection(PF2E_DEFAULT_BASE_URL, 'conditions', quietLogger),
    // `vehicles` is the cheapest AoN section that carries real mechanics (~137 rows) and it
    // exercises both shape traps at once: `price`/`passengers` are number + `_raw` display
    // pairs, and `size` is a one-element array.
    facts: {
      section: 'vehicles',
      requiredFactKeys: ['price', 'ac', 'hp', 'speed', 'crew', 'size'],
      minRatio: 0.8,
      run: () => fetchPf2eSection(PF2E_DEFAULT_BASE_URL, 'vehicles', quietLogger),
    },
  },
  {
    kind: 'live',
    module: 'pf2e-importer',
    sources: ['sf2e'],
    constName: 'SF2E_DEFAULT_BASE_URL',
    baseUrl: SF2E_DEFAULT_BASE_URL,
    section: 'conditions',
    expectedEntryType: pf2eEntryType('conditions'),
    minEntries: 3, // the SF2e index is much smaller than PF2e's
    minBodyRatio: 0.5,
    rawChecks: [
      {
        label: `index "${SF2E_INDEX}" type:condition`,
        url: `${SF2E_DEFAULT_BASE_URL.replace(/\/$/, '')}/${SF2E_INDEX}/_search?q=${encodeURIComponent('type:condition')}&size=1`,
        format: 'json',
        container: 'hits.hits',
      },
    ],
    run: () => fetchSf2eSection(SF2E_DEFAULT_BASE_URL, 'conditions', quietLogger),
    // SF2e vehicles publish no `hp`; the rest of the mechanical block is the same shape.
    facts: {
      section: 'vehicles',
      requiredFactKeys: ['price', 'ac', 'speed', 'crew', 'size'],
      minRatio: 0.8,
      run: () => fetchSf2eSection(SF2E_DEFAULT_BASE_URL, 'vehicles', quietLogger),
    },
  },
  {
    kind: 'live',
    module: 'cepheus-importer',
    sources: ['cepheus'],
    constName: 'CEPHEUS_DEFAULT_BASE_URL',
    baseUrl: CEPHEUS_DEFAULT_BASE_URL,
    // 'reference' is the cheapest book: three short front-matter chapters.
    section: 'reference',
    expectedEntryType: entryTypeForCepheusSection('reference'),
    minEntries: 3,
    minBodyRatio: 1, // every chapter is prose; an empty body means the .md path moved
    // Markdown, not JSON. Probing EVERY chapter path is the point: the manifest is hardcoded
    // against the mdbook branch, so a renamed/removed chapter file is silent 404 drift.
    rawChecks: CEPHEUS_CHAPTERS.map((chapter) => ({
      label: `chapter "${chapter.path}"`,
      url: `${CEPHEUS_DEFAULT_BASE_URL.replace(/\/$/, '')}/${chapter.path}`,
      format: 'text' as const,
    })),
    run: () => fetchCepheusSection(CEPHEUS_DEFAULT_BASE_URL, 'reference', quietLogger),
  },
  {
    kind: 'live',
    module: 'datasworn-importer',
    sources: ['datasworn'],
    // Datasworn's source is a single JSON FILE, not a base URL to build paths under, so the
    // importer exports DATASWORN_STARFORGED_URL rather than a `*_DEFAULT_BASE_URL`. The
    // coverage guard below handles that honestly: it requires every importer file to be
    // claimed, and every `*_DEFAULT_BASE_URL` that DOES exist to be claimed.
    constName: null,
    baseUrl: DATASWORN_STARFORGED_URL,
    section: 'truths',
    expectedEntryType: entryTypeForDataswornSection('truths'),
    minEntries: 5, // Starforged ships ~14 setting truths
    minBodyRatio: 1,
    rawChecks: [
      { label: 'starforged.json', url: DATASWORN_STARFORGED_URL, format: 'text' },
    ],
    run: async () => {
      // fetchDataswornDocument already enforces JSON-ness, the top-level ruleset shape, and
      // an open (CC-BY) license before any mapping — exactly the drift assertions we want.
      const doc = await fetchDataswornDocument(DATASWORN_STARFORGED_URL, quietLogger);
      return mapDataswornSection(doc, 'truths', quietLogger);
    },
  },
  // ---- manual-upload sources: no live default to smoke, only a guard to hold (see #555) ----
  {
    kind: 'manual-upload',
    module: 'starfinder-importer',
    sources: ['starfinder'],
    constName: 'STARFINDER_DEFAULT_BASE_URL',
    baseUrl: STARFINDER_DEFAULT_BASE_URL,
  },
  {
    kind: 'manual-upload',
    module: 'archmage-importer',
    sources: ['archmage'],
    constName: 'ARCHMAGE_DEFAULT_BASE_URL',
    baseUrl: ARCHMAGE_DEFAULT_BASE_URL,
  },
  {
    kind: 'manual-upload',
    module: 'pathfinder1e-importer',
    sources: ['pf1e'],
    constName: 'PF1E_DEFAULT_BASE_URL',
    baseUrl: PF1E_DEFAULT_BASE_URL,
  },
  {
    kind: 'manual-upload',
    module: 'osr-importer',
    sources: ['osr'],
    // The OSR importer deliberately exports no default base URL at all — each retroclone's
    // OsrSource carries only a human-facing `sourceUrl`, never a machine-readable API.
    constName: null,
    baseUrl: '',
  },
];

/** Importer modules on disk — the authoritative list the coverage guard compares against. */
function importerModulesOnDisk(): string[] {
  return readdirSync(RULES_SRC_DIR)
    .filter((f) => f.endsWith('-importer.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

/** Every `export const X_DEFAULT_BASE_URL` declared across the importer modules, by module. */
function declaredDefaultBaseUrlConsts(): Array<{ module: string; constName: string }> {
  const found: Array<{ module: string; constName: string }> = [];
  for (const mod of importerModulesOnDisk()) {
    const src = readFileSync(path.join(RULES_SRC_DIR, `${mod}.ts`), 'utf8');
    for (const m of src.matchAll(/^export const (\w+_DEFAULT_BASE_URL)\b/gm)) {
      found.push({ module: mod, constName: m[1] });
    }
  }
  return found;
}

/** Resolve a dotted path (e.g. 'hits.hits') against a parsed JSON body. */
function atPath(body: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, body);
}

/** Failure prefix that names the importer and URL that drifted — the nightly must be actionable. */
function where(probe: RuleSourceProbe, extra = ''): string {
  const constLabel = probe.constName ?? '(no *_DEFAULT_BASE_URL export)';
  return `[${probe.sources.join('/')}] ${probe.module} ${constLabel}=${probe.baseUrl || '(empty)'}${extra ? ` ${extra}` : ''}`;
}

// ---------------------------------------------------------------------------
// Layer 1 — coverage guards. No network; these run in ordinary CI so a new
// importer cannot be added without live-smoke coverage.
// ---------------------------------------------------------------------------
describe('rules — live-source smoke coverage guard (issue #568)', () => {
  it('every importer module on disk is claimed by a probe', () => {
    const claimed = new Set(RULE_SOURCE_PROBES.map((p) => p.module));
    const onDisk = importerModulesOnDisk();
    // Failing list reads as "these importers have no live-source smoke — add a probe to
    // RULE_SOURCE_PROBES", which is the whole point of the guard.
    expect(onDisk.filter((m) => !claimed.has(m))).toEqual([]);
    // And no probe may claim a module that no longer exists (a deleted importer must not
    // leave a probe silently "passing" against nothing).
    expect([...claimed].filter((m) => !onDisk.includes(m))).toEqual([]);
  });

  it('every exported *_DEFAULT_BASE_URL is claimed by exactly one probe', () => {
    const declared = declaredDefaultBaseUrlConsts();
    const claimed = RULE_SOURCE_PROBES.map((p) => p.constName).filter((c): c is string => c !== null);
    // Every constant that exists must be probed…
    for (const { module, constName } of declared) {
      expect(`${module}:${constName}:${claimed.filter((c) => c === constName).length}`).toBe(`${module}:${constName}:1`);
    }
    // …and every claimed constant must actually exist (no probe against a deleted constant).
    const declaredNames = new Set(declared.map((d) => d.constName));
    expect(claimed.filter((c) => !declaredNames.has(c))).toEqual([]);
  });

  it('every RulePackInstallSource is claimed by exactly one probe', () => {
    const claimed = RULE_SOURCE_PROBES.flatMap((p) => p.sources);
    for (const source of RulePackInstallSource.options) {
      expect(`${source}:${claimed.filter((s) => s === source).length}`).toBe(`${source}:1`);
    }
    // No probe may claim a source the enum no longer has.
    expect(claimed.filter((s) => !RulePackInstallSource.options.includes(s))).toEqual([]);
  });

  it('probe kind agrees with the shared source metadata (live <-> installableWithoutUrl)', () => {
    for (const probe of RULE_SOURCE_PROBES) {
      for (const source of probe.sources) {
        const meta = RULE_PACK_SOURCE_META[source];
        expect(`${source}:${probe.kind}`).toBe(`${source}:${meta.installableWithoutUrl ? 'live' : 'manual-upload'}`);
      }
    }
  });

  it('every live probe has a non-empty absolute https base URL', () => {
    for (const probe of RULE_SOURCE_PROBES) {
      if (probe.kind !== 'live') continue;
      // A placeholder/empty default is the #555 bug class: it must never reach a live probe.
      // Asserting on the labelled string keeps the offending importer visible in the diff.
      expect(`${where(probe)} https=${probe.baseUrl.startsWith('https://')}`).toBe(`${where(probe)} https=true`);
      expect(`${where(probe)} rawChecks=${probe.rawChecks.length > 0}`).toBe(`${where(probe)} rawChecks=true`);
      for (const check of probe.rawChecks) {
        // Every probed URL must hang off the importer's own constant — no literals in the test.
        const derived = check.url.startsWith(probe.baseUrl.replace(/\/$/, ''));
        expect(`${where(probe, check.label)} derived=${derived}`).toBe(`${where(probe, check.label)} derived=true`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 1b — the manual-upload contract (#555). Offline: the rejection happens
// synchronously at enqueue, before any fetch, so this is safe in normal CI and
// proves a dead/placeholder default can never be silently used.
// ---------------------------------------------------------------------------
describe('rules — manual-upload sources reject the default install path (issues #555, #568)', () => {
  let ctx: TestAppContext;
  let server: Server;
  const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const manualProbes = RULE_SOURCE_PROBES.filter((p): p is ManualUploadProbe => p.kind === 'manual-upload');

  for (const probe of manualProbes) {
    for (const source of probe.sources) {
      it(`source "${source}" is rejected 400 with no url (no live fetch attempted)`, async () => {
        const res = await request(server).post('/api/v1/rules/packs/install').set(dm).send({ source });
        expect(`${where(probe)} -> HTTP ${res.status}`).toBe(`${where(probe)} -> HTTP 400`);
        expect(String(res.body.message)).toMatch(/url/i);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Layer 2 — live probes. Skipped unless RUN_LIVE_RULES_SMOKE=1; run nightly by
// .github/workflows/rules-live-smoke.yml.
// ---------------------------------------------------------------------------
liveSmoke('rules — live rule-source smoke (issue #568)', () => {
  const liveProbes = RULE_SOURCE_PROBES.filter((p): p is LiveProbe => p.kind === 'live');

  for (const probe of liveProbes) {
    describe(`${probe.sources.join('/')} (${probe.baseUrl})`, () => {
      it(
        'every URL the importer requests resolves and is not an HTML error page',
        async () => {
          for (const check of probe.rawChecks) {
            const label = `${where(probe, check.label)} url=${check.url}`;
            let res: Response;
            try {
              res = await fetch(check.url, { headers: { accept: '*/*' } });
            } catch (err) {
              throw new Error(`${label}: request failed — ${(err as Error).message}`, { cause: err });
            }
            expect(`${label} -> HTTP ${res.status}`).toBe(`${label} -> HTTP 200`);

            const text = await res.text();
            if (text.trim().length === 0) {
              throw new Error(`${label}: responded 200 with an EMPTY body`);
            }
            // An upstream answering 200 with its SPA shell is exactly how `/v2/races/` broke
            // (see the open5e-importer header) — a status check alone would have missed it.
            const head = text.trimStart().slice(0, 400).toLowerCase();
            if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head>')) {
              throw new Error(`${label}: responded with HTML, not data — upstream moved or is serving an error page`);
            }

            if (check.format === 'json') {
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch (err) {
                throw new Error(`${label}: body is not valid JSON — ${(err as Error).message}`, { cause: err });
              }
              if (check.container) {
                const container = atPath(parsed, check.container);
                if (!Array.isArray(container)) {
                  throw new Error(
                    `${label}: response has no "${check.container}" array — the field the importer reads is gone (upstream shape changed)`,
                  );
                }
                if (container.length === 0) {
                  throw new Error(`${label}: "${check.container}" is empty — the path resolves but serves no rows`);
                }
              }
            }
          }
        },
        LIVE_TIMEOUT_MS,
      );

      it(
        `section "${probe.section}" survives the importer's own fetch + mapping`,
        async () => {
          const label = where(probe, `section "${probe.section}"`);
          let result: ProbeSectionResult;
          try {
            result = await probe.run();
          } catch (err) {
            // The importers throw BadRequestException with the offending URL/status/parse error
            // baked in, so re-raising with the probe label yields a fully actionable failure.
            throw new Error(`${label}: importer failed against the live source — ${(err as Error).message}`, { cause: err });
          }

          const entries = result.entries;
          if (entries.length < probe.minEntries) {
            throw new Error(
              `${label}: imported ${entries.length} entries, expected at least ${probe.minEntries} — upstream shrank, renamed the section, or changed its row shape`,
            );
          }

          for (const entry of entries) {
            if (!entry.name?.trim() || !entry.slug?.trim()) {
              throw new Error(`${label}: mapped an entry with an empty name/slug (${JSON.stringify(entry).slice(0, 200)})`);
            }
            if (entry.type !== probe.expectedEntryType) {
              throw new Error(
                `${label}: entry "${entry.name}" mapped to type "${entry.type}", expected "${probe.expectedEntryType}"`,
              );
            }
            if (!entry.license?.trim()) {
              throw new Error(`${label}: entry "${entry.name}" carries no license — provenance would be lost on install`);
            }
          }

          // A renamed upstream prose field does NOT throw: the mappers fall back to '' and would
          // happily import a pack of empty entries. Requiring most bodies to be non-empty is what
          // turns that silent degradation into a nightly failure.
          const withBody = entries.filter((e) => e.body?.trim().length > 0).length;
          if (withBody / entries.length < probe.minBodyRatio) {
            throw new Error(
              `${label}: only ${withBody}/${entries.length} entries have a non-empty body (need >= ${Math.round(
                probe.minBodyRatio * 100,
              )}%) — the upstream prose field was probably renamed`,
            );
          }
        },
        LIVE_TIMEOUT_MS,
      );

      const facts = probe.facts;
      if (facts) {
        it(
          `section "${facts.section}" still yields its mechanical fields, not just prose`,
          async () => {
            const label = where(probe, `section "${facts.section}"`);
            let result: ProbeSectionResult;
            try {
              result = await facts.run();
            } catch (err) {
              throw new Error(`${label}: importer failed against the live source — ${(err as Error).message}`, { cause: err });
            }
            const entries = result.entries;
            if (entries.length === 0) throw new Error(`${label}: imported 0 entries — nothing to check facts against`);

            const parsed = entries.map((entry) => {
              try {
                const value: unknown = entry.dataJson ? JSON.parse(entry.dataJson) : null;
                return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
              } catch {
                return {};
              }
            });

            const missing = facts.requiredFactKeys
              .map((key) => ({ key, present: parsed.filter((d) => d[key] !== undefined && d[key] !== null).length }))
              .filter(({ present }) => present / entries.length < facts.minRatio);

            // A live section that cannot prove it saw every row is a real regression even
            // though it imports fine: `truncated` is what stops rules.service from treating
            // the fetch as a complete manifest, so it silently disables removal on every
            // subsequent re-import. It is set here only when the scan actually lost rows
            // (see the row-count check in the importer) or hit a cap this section is nowhere
            // near, so on a healthy upstream it must be false.
            if (result.truncated) {
              throw new Error(
                `${label}: the scan could not account for every row the source reported (truncated) — ` +
                  'paging lost rows, or the section outgrew its cap. Pack re-imports will refuse to remove stale entries until this is fixed.',
              );
            }

            if (missing.length > 0) {
              throw new Error(
                `${label}: dataJson is missing expected mechanical fields on most rows — ` +
                  missing.map((m) => `"${m.key}" on ${m.present}/${entries.length}`).join(', ') +
                  ` (need >= ${Math.round(facts.minRatio * 100)}% each). The upstream field was renamed, ` +
                  'changed type (a number where a string is read, or a bare scalar where a one-element array is read), or moved.',
              );
            }
          },
          LIVE_TIMEOUT_MS,
        );
      }
    });
  }
});
