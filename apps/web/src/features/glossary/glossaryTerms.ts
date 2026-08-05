export const GLOSSARY_TERM_IDS = [
  'cast',
  'scribe',
  'proposals',
  'compendium',
  'sessionZero',
  'storylines',
  'coDm',
  'driver',
  'dangerLevel',
] as const;

export type GlossaryTermId = (typeof GLOSSARY_TERM_IDS)[number];

export type GlossaryTerm = {
  labelKey: string;
  shortKey: string;
  definitionKey: string;
  audienceKey: string;
  visibilityKey: string;
  phaseKey: string;
};

export function glossaryAnchorId(termId: GlossaryTermId): string {
  return `glossary-${termId}`;
}

export function glossaryTermHref(termId: GlossaryTermId): string {
  return `/glossary#${glossaryAnchorId(termId)}`;
}

export const TERM_HELP_STORAGE_PREFIX = 'cf.termHelp.dismissed.';

export function termHelpStorageKey(termId: GlossaryTermId): string {
  return `${TERM_HELP_STORAGE_PREFIX}${termId}`;
}

export const GLOSSARY_TERMS: Record<GlossaryTermId, GlossaryTerm> = {
  cast: {
    labelKey: 'glossary.terms.cast.label',
    shortKey: 'glossary.terms.cast.short',
    definitionKey: 'glossary.terms.cast.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.playerSafe',
    phaseKey: 'glossary.phase.livePlay',
  },
  scribe: {
    labelKey: 'glossary.terms.scribe.label',
    shortKey: 'glossary.terms.scribe.short',
    definitionKey: 'glossary.terms.scribe.definition',
    audienceKey: 'glossary.audience.dm',
    visibilityKey: 'glossary.visibility.proposals',
    phaseKey: 'glossary.phase.prepRecords',
  },
  proposals: {
    labelKey: 'glossary.terms.proposals.label',
    shortKey: 'glossary.terms.proposals.short',
    definitionKey: 'glossary.terms.proposals.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.canonGate',
    phaseKey: 'glossary.phase.prepCanon',
  },
  compendium: {
    labelKey: 'glossary.terms.compendium.label',
    shortKey: 'glossary.terms.compendium.short',
    definitionKey: 'glossary.terms.compendium.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.rulesOnly',
    phaseKey: 'glossary.phase.reference',
  },
  sessionZero: {
    labelKey: 'glossary.terms.sessionZero.label',
    shortKey: 'glossary.terms.sessionZero.short',
    definitionKey: 'glossary.terms.sessionZero.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.tableVisible',
    phaseKey: 'glossary.phase.prepSafety',
  },
  storylines: {
    labelKey: 'glossary.terms.storylines.label',
    shortKey: 'glossary.terms.storylines.short',
    definitionKey: 'glossary.terms.storylines.definition',
    audienceKey: 'glossary.audience.dm',
    visibilityKey: 'glossary.visibility.dmOnly',
    phaseKey: 'glossary.phase.prepCanon',
  },
  coDm: {
    labelKey: 'glossary.terms.coDm.label',
    shortKey: 'glossary.terms.coDm.short',
    definitionKey: 'glossary.terms.coDm.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.proposals',
    phaseKey: 'glossary.phase.aiAssist',
  },
  driver: {
    labelKey: 'glossary.terms.driver.label',
    shortKey: 'glossary.terms.driver.short',
    definitionKey: 'glossary.terms.driver.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.liveCanonSplit',
    phaseKey: 'glossary.phase.livePlay',
  },
  // Issue #871: campaign-wide danger level was unexplained and shown beside live
  // encounter/session/location state, so users could not tell whether it meant campaign
  // tone, current threat, encounter difficulty, or content/safety severity. This entry is
  // the definition: object (whole campaign), timeframe (persistent), audience (everyone),
  // owner (DM), consequence (narrative-only) — see glossary.terms.dangerLevel.definition.
  dangerLevel: {
    labelKey: 'glossary.terms.dangerLevel.label',
    shortKey: 'glossary.terms.dangerLevel.short',
    definitionKey: 'glossary.terms.dangerLevel.definition',
    audienceKey: 'glossary.audience.all',
    visibilityKey: 'glossary.visibility.dmSetTableVisible',
    phaseKey: 'glossary.phase.campaignSetting',
  },
};
