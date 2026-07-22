const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class ReleaseError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.details = details;
  }
}

export function parseReleaseTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new ReleaseError(
      'INVALID_TAG',
      `Tag ${JSON.stringify(tag)} is not a stable SemVer tag in the required vX.Y.Z form.`,
    );
  }
  return {
    tag,
    version: match.slice(1).join('.'),
    parts: match.slice(1).map(Number),
  };
}

export function compareSemver(left, right) {
  const a = typeof left === 'string' ? parseReleaseTag(left).parts : left;
  const b = typeof right === 'string' ? parseReleaseTag(right).parts : right;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function pointerValue(document, pointer) {
  let value = document;
  for (const segment of pointer) {
    if (value === null || typeof value !== 'object' || !(segment in value)) return undefined;
    value = value[segment];
  }
  return value;
}

export function validateVersionDocuments(documents, sources, expectedVersion) {
  const mismatches = [];
  for (const source of sources) {
    const document = documents.get(source.path);
    const actual = document === undefined ? undefined : pointerValue(document, source.pointer);
    if (actual !== expectedVersion) {
      mismatches.push({ label: source.label, path: source.path, actual, expected: expectedVersion });
    }
  }
  if (mismatches.length > 0) {
    const summary = mismatches
      .map(({ label, actual }) => `${label}=${actual === undefined ? '<missing>' : JSON.stringify(actual)}`)
      .join(', ');
    throw new ReleaseError(
      'VERSION_MISMATCH',
      `Version metadata is not synchronized at ${expectedVersion}: ${summary}.`,
      mismatches,
    );
  }
  return true;
}

export function versionValues(documents, sources) {
  return sources.map((source) => ({
    label: source.label,
    path: source.path,
    value: pointerValue(documents.get(source.path), source.pointer),
  }));
}

export function validateVersionTransition(documents, sources, nextTag) {
  const next = parseReleaseTag(nextTag);
  const invalid = [];
  for (const source of versionValues(documents, sources)) {
    let previous;
    try {
      previous = parseReleaseTag(`v${source.value}`);
    } catch {
      invalid.push(`${source.label}=${source.value === undefined ? '<missing>' : JSON.stringify(source.value)}`);
      continue;
    }
    if (compareSemver(next.parts, previous.parts) <= 0) invalid.push(`${source.label}=${JSON.stringify(source.value)}`);
  }
  if (invalid.length > 0) {
    throw new ReleaseError(
      'INVALID_VERSION_TRANSITION',
      `${nextTag} is not a forward version change from every parent metadata source: ${invalid.join(', ')}.`,
      invalid,
    );
  }
}

export function selectHighestPreviousVersion(candidates, currentTag) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((left, right) => compareSemver(right.tag, left.tag));
  const selected = sorted[0];
  if (compareSemver(currentTag, selected.tag) <= 0) {
    throw new ReleaseError(
      'STALE_TAG',
      `${currentTag} is not newer than previous valid release ${selected.tag}.`,
    );
  }
  return selected;
}

const CATEGORY_RULES = [
  ['Security', /\b(security|vulnerab|cve|authz|privilege|secret leak)\b/i],
  ['Accessibility', /\b(accessibility|a11y|screen reader|keyboard nav|aria)\b/i],
  ['Bug fixes', /\b(bug|fix|regression|defect|crash|incorrect|race)\b/i],
  ['Features', /\b(feature|enhancement|feat|add|introduc|support)\b/i],
  ['Polish', /\b(polish|ux|ui|style|design|responsive|copy)\b/i],
  ['Testing', /\b(test|testing|coverage|ci)\b/i],
  ['Documentation', /\b(doc|documentation|readme|guide)\b/i],
];

export const CATEGORY_ORDER = CATEGORY_RULES.map(([name]) => name).concat('Other changes');

function searchableText(change) {
  const labels = (change.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
  return `${labels.join(' ')} ${change.title ?? ''} ${change.body ?? ''}`;
}

export function categoryForChange(change) {
  const text = searchableText(change);
  for (const [category, expression] of CATEGORY_RULES) {
    if (expression.test(text)) return category;
  }
  return 'Other changes';
}

export function extractClosingIssueNumbers(body) {
  if (!body) return [];
  const numbers = new Set();
  const expression = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+([^\n.;]+)/gi;
  for (const clause of body.matchAll(expression)) {
    for (const match of clause[1].matchAll(/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)\b/g)) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers];
}

const CALLOUTS = [
  ['Migrations', /\b(migration|migrate|database schema|data backfill)\b/i],
  ['Configuration', /\b(configuration|config|environment variable|env var|\.env\b)\b/i],
  ['Compatibility', /\b(compatibility|breaking change|deprecat|minimum version|requires? node)\b/i],
  ['Known limitations', /\b(known limitation|known issue|not supported|unsupported|follow[- ]?up)\b/i],
];

function markdownLink(label, url) {
  return url ? `[${label}](${url})` : label;
}

function changeBullet(change, issuesByNumber) {
  const number = change.number ? `#${change.number}` : change.shortSha;
  const link = markdownLink(number, change.html_url);
  const issueLinks = (change.closedIssueNumbers ?? [])
    .map((issueNumber) => issuesByNumber.get(issueNumber))
    .filter(Boolean)
    .map((issue) => markdownLink(`#${issue.number}`, issue.html_url));
  const closes = issueLinks.length > 0 ? ` (closes ${issueLinks.join(', ')})` : '';
  return `- ${change.title} (${link})${closes}`;
}

export function generateReleaseNotes({ tag, previousTag, changes, issues = [] }) {
  const deduplicated = new Map();
  for (const change of changes) {
    const key = change.number ? `pr:${change.number}` : `commit:${change.sha}`;
    if (!deduplicated.has(key)) deduplicated.set(key, change);
  }
  const uniqueChanges = [...deduplicated.values()];
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const grouped = new Map(CATEGORY_ORDER.map((category) => [category, []]));
  for (const change of uniqueChanges) grouped.get(categoryForChange(change)).push(change);

  const lines = [
    `# Campfire ${tag}`,
    '',
    `Changes since ${previousTag}.`,
    '',
  ];
  for (const category of CATEGORY_ORDER) {
    const entries = grouped.get(category);
    if (entries.length === 0) continue;
    lines.push(`## ${category}`, '');
    for (const change of entries) lines.push(changeBullet(change, issuesByNumber));
    lines.push('');
  }

  lines.push('## Operational notes', '');
  for (const [label, expression] of CALLOUTS) {
    const matches = uniqueChanges.filter((change) => expression.test(searchableText(change)));
    if (matches.length === 0) {
      lines.push(`- **${label}:** None identified in merged pull request metadata.`);
    } else {
      const links = matches.map((change) => markdownLink(`#${change.number ?? change.shortSha}`, change.html_url));
      lines.push(`- **${label}:** ${links.join(', ')}`);
    }
  }

  const contributors = new Map();
  for (const change of uniqueChanges) {
    if (change.author?.login) contributors.set(change.author.login, change.author.html_url);
  }
  lines.push('', '## Contributors', '');
  if (contributors.size === 0) {
    lines.push('- No linked pull-request contributors were found.');
  } else {
    for (const [login, url] of [...contributors].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${markdownLink(`@${login}`, url)}`);
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

export function normalizeCommitChange(commit, repositoryUrl) {
  const title = commit.commit?.message?.split('\n')[0]?.trim() || commit.sha.slice(0, 7);
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    title,
    body: commit.commit?.message ?? '',
    html_url: commit.html_url ?? `${repositoryUrl}/commit/${commit.sha}`,
    labels: [],
    author: commit.author ?? null,
    closedIssueNumbers: extractClosingIssueNumbers(commit.commit?.message),
  };
}

export function normalizePullRequest(pr) {
  return {
    number: pr.number,
    sha: pr.merge_commit_sha,
    shortSha: pr.merge_commit_sha?.slice(0, 7),
    title: pr.title,
    body: pr.body ?? '',
    html_url: pr.html_url,
    labels: pr.labels ?? [],
    author: pr.user ?? null,
    closedIssueNumbers: extractClosingIssueNumbers(pr.body),
  };
}
