/**
 * Pure preview builders for the entity reveal confirmation dialog (issue #710).
 * Each builder lists what campaign members gain when a hidden prep entity becomes
 * player-visible, including linked content surfaced on the detail page.
 */

export type RevealPreviewItem = {
  /** Short category label — "Description", "Connected quest", … */
  label: string;
  /** Primary text shown in the preview list. */
  value: string;
};

const PREVIEW_SNIPPET_MAX = 160;

/** Trim long markdown/plain text for the reveal preview without breaking mid-word. */
export function previewSnippet(text: string, max = PREVIEW_SNIPPET_MAX): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export function buildQuestRevealPreview(input: {
  title: string;
  body: string;
  reward?: string;
  objectives?: Array<{ text: string }>;
  giverName?: string | null;
  subquestTitles?: string[];
}): RevealPreviewItem[] {
  const items: RevealPreviewItem[] = [{ label: 'Quest', value: input.title }];
  const body = previewSnippet(input.body);
  if (body) items.push({ label: 'Description', value: body });
  if (input.reward?.trim()) items.push({ label: 'Reward', value: input.reward.trim() });
  for (const o of input.objectives ?? []) {
    if (o.text.trim()) items.push({ label: 'Objective', value: o.text.trim() });
  }
  if (input.giverName) items.push({ label: 'Quest giver', value: input.giverName });
  for (const title of input.subquestTitles ?? []) {
    if (title.trim()) items.push({ label: 'Subquest', value: title.trim() });
  }
  return items;
}

export function buildNpcRevealPreview(input: {
  name: string;
  role?: string;
  body: string;
  factionName?: string | null;
  locationName?: string | null;
  connectedQuestTitles?: string[];
}): RevealPreviewItem[] {
  const items: RevealPreviewItem[] = [{ label: 'NPC', value: input.name }];
  if (input.role?.trim()) items.push({ label: 'Role', value: input.role.trim() });
  const body = previewSnippet(input.body);
  if (body) items.push({ label: 'Description', value: body });
  if (input.factionName) items.push({ label: 'Faction', value: input.factionName });
  if (input.locationName) items.push({ label: 'Last seen', value: input.locationName });
  for (const title of input.connectedQuestTitles ?? []) {
    if (title.trim()) items.push({ label: 'Connected quest', value: title.trim() });
  }
  return items;
}

export function buildFactionRevealPreview(input: {
  name: string;
  kind?: string;
  body: string;
  goals?: string;
  memberNames?: string[];
}): RevealPreviewItem[] {
  const items: RevealPreviewItem[] = [{ label: 'Faction', value: input.name }];
  if (input.kind?.trim()) items.push({ label: 'Kind', value: input.kind.trim() });
  const body = previewSnippet(input.body);
  if (body) items.push({ label: 'Description', value: body });
  const goals = previewSnippet(input.goals ?? '');
  if (goals) items.push({ label: 'Goals', value: goals });
  for (const name of input.memberNames ?? []) {
    if (name.trim()) items.push({ label: 'Member NPC', value: name.trim() });
  }
  return items;
}

export function buildLocationRevealPreview(input: {
  name: string;
  kind?: string;
  body: string;
  hereNpcNames?: string[];
  connectedQuestTitles?: string[];
  childLocationNames?: string[];
}): RevealPreviewItem[] {
  const items: RevealPreviewItem[] = [{ label: 'Location', value: input.name }];
  if (input.kind?.trim()) items.push({ label: 'Kind', value: input.kind.trim() });
  const body = previewSnippet(input.body);
  if (body) items.push({ label: 'Description', value: body });
  for (const name of input.hereNpcNames ?? []) {
    if (name.trim()) items.push({ label: 'NPC here', value: name.trim() });
  }
  for (const title of input.connectedQuestTitles ?? []) {
    if (title.trim()) items.push({ label: 'Connected quest', value: title.trim() });
  }
  for (const name of input.childLocationNames ?? []) {
    if (name.trim()) items.push({ label: 'Contains', value: name.trim() });
  }
  return items;
}
