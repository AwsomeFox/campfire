#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GitHubApi } from './github-api.mjs';
import {
  ReleaseError,
  compareSemver,
  extractClosingIssueNumbers,
  generateReleaseNotes,
  normalizeCommitChange,
  normalizePullRequest,
  parseReleaseTag,
  selectHighestPreviousVersion,
  validateVersionDocuments,
  validateVersionTransition,
} from './release-lib.mjs';

async function resolveTag(api, tag, { requireAnnotated = false } = {}) {
  const ref = await api.getRef(`tags/${tag}`);
  if (!ref) throw new ReleaseError('MISSING_TAG', `Tag ${tag} does not exist in the repository.`);
  if (ref.object?.type === 'commit' && !requireAnnotated) {
    return { commitSha: ref.object.sha, tagObjectSha: null, annotated: false };
  }
  if (ref.object?.type !== 'tag') {
    throw new ReleaseError('LIGHTWEIGHT_TAG', `Tag ${tag} is lightweight; releases require a deliberately created annotated tag.`);
  }
  const annotated = await api.getAnnotatedTag(ref.object.sha);
  if (annotated.tag !== tag || annotated.object?.type !== 'commit') {
    throw new ReleaseError('INVALID_TAG_OBJECT', `Annotated tag ${tag} does not point directly to a commit.`);
  }
  return { commitSha: annotated.object.sha, tagObjectSha: ref.object.sha, annotated: true };
}

async function readVersionDocuments(api, ref, sources) {
  const paths = [...new Set(sources.map((source) => source.path))];
  return new Map(await Promise.all(paths.map(async (path) => [path, await api.getJsonFile(path, ref)])));
}

async function validateVersionsAtRef(api, ref, tag, sources) {
  const { version } = parseReleaseTag(tag);
  const documents = await readVersionDocuments(api, ref, sources);
  validateVersionDocuments(documents, sources, version);
  return documents;
}

async function assertAncestor(api, ancestorSha, descendantSha, diagnostic) {
  if (ancestorSha === descendantSha) return;
  const comparison = await api.compare(ancestorSha, descendantSha);
  if (comparison.merge_base_commit?.sha !== ancestorSha || !['ahead', 'identical'].includes(comparison.status)) {
    throw new ReleaseError('DIVERGENT_TAG', diagnostic);
  }
}

async function validateReleaseCommit(api, commitSha, tag, config) {
  const commit = await api.getCommit(commitSha);
  if (!commit.parents?.length) {
    throw new ReleaseError('NOT_RELEASE_COMMIT', `Tagged commit ${commitSha} has no parent and cannot be a version bump commit.`);
  }
  const requiredPaths = new Set(config.versionSources.map((source) => source.path));
  const changedPaths = new Set((commit.files ?? []).map((file) => file.filename));
  const missing = [...requiredPaths].filter((path) => !changedPaths.has(path));
  if (missing.length > 0) {
    throw new ReleaseError(
      'NOT_RELEASE_COMMIT',
      `Tagged commit ${commitSha} is not the synchronized version commit; it did not change: ${missing.join(', ')}.`,
    );
  }
  const parentDocuments = await readVersionDocuments(api, commit.parents[0].sha, config.versionSources);
  validateVersionTransition(parentDocuments, config.versionSources, tag);
  return commit;
}

export function verifyRequiredChecks(payload, requiredChecks) {
  const runs = payload.check_runs ?? [];
  const latest = new Map();
  for (const run of runs) {
    if (run.app?.slug !== 'github-actions') continue;
    const previous = latest.get(run.name);
    const currentTime = Date.parse(run.completed_at ?? run.started_at ?? run.created_at ?? 0);
    const previousTime = Date.parse(previous?.completed_at ?? previous?.started_at ?? previous?.created_at ?? 0);
    if (!previous || currentTime >= previousTime) latest.set(run.name, run);
  }
  const failures = [];
  for (const name of requiredChecks) {
    const run = latest.get(name);
    if (!run) failures.push(`${name}=missing`);
    else if (run.status !== 'completed' || run.conclusion !== 'success') {
      failures.push(`${name}=${run.status}/${run.conclusion ?? 'no conclusion'}`);
    }
  }
  if (failures.length > 0) {
    throw new ReleaseError(
      'REQUIRED_CI_FAILED',
      `Required CI has not passed on the tagged commit: ${failures.join(', ')}.`,
      failures,
    );
  }
}

async function candidateFromRelease(api, release, currentSha, config) {
  if (release.draft) return { rejection: `${release.tag_name ?? '<untagged>'}: draft release` };
  if (release.prerelease) return { rejection: `${release.tag_name ?? '<untagged>'}: prerelease` };
  try {
    parseReleaseTag(release.tag_name);
  } catch (error) {
    return { rejection: `${release.tag_name ?? '<untagged>'}: ${error.code}` };
  }
  let resolved;
  try {
    resolved = await resolveTag(api, release.tag_name);
    await assertAncestor(
      api,
      resolved.commitSha,
      currentSha,
      `Released tag ${release.tag_name} is not an ancestor of the new tagged commit.`,
    );
    await validateVersionsAtRef(api, resolved.commitSha, release.tag_name, config.versionSources);
  } catch (error) {
    if (error instanceof ReleaseError) return { rejection: `${release.tag_name}: ${error.code}` };
    throw error;
  }
  return { candidate: { tag: release.tag_name, commitSha: resolved.commitSha, release } };
}

export async function selectPreviousValidRelease(api, currentTag, currentSha, config) {
  const releases = await api.listReleases();
  const inspected = await Promise.all(
    releases.map((release) => candidateFromRelease(api, release, currentSha, config)),
  );
  const candidates = inspected.flatMap((result) => result.candidate ? [result.candidate] : []);
  const rejections = inspected.flatMap((result) => result.rejection ? [result.rejection] : []);
  const selected = selectHighestPreviousVersion(candidates, currentTag);
  if (selected) return { ...selected, source: 'release' };

  if (!config.bootstrap) {
    throw new ReleaseError(
      'NO_BASELINE',
      `No prior valid non-draft GitHub Release exists and no explicit bootstrap baseline is configured.${
        rejections.length > 0 ? ` Rejected candidates: ${rejections.join(', ')}.` : ''
      }`,
      rejections,
    );
  }
  const bootstrapTag = parseReleaseTag(config.bootstrap.tag);
  if (compareSemver(currentTag, bootstrapTag.tag) <= 0) {
    throw new ReleaseError('STALE_TAG', `${currentTag} is not newer than bootstrap ${bootstrapTag.tag}.`);
  }
  const resolved = await resolveTag(api, bootstrapTag.tag);
  if (resolved.commitSha !== config.bootstrap.commitSha) {
    throw new ReleaseError(
      'BOOTSTRAP_MOVED',
      `Bootstrap ${bootstrapTag.tag} resolves to ${resolved.commitSha}, not pinned commit ${config.bootstrap.commitSha}.`,
    );
  }
  await assertAncestor(
    api,
    resolved.commitSha,
    currentSha,
    `Bootstrap ${bootstrapTag.tag} is not an ancestor of the new tagged commit.`,
  );
  await validateVersionsAtRef(api, resolved.commitSha, bootstrapTag.tag, config.versionSources);
  return { tag: bootstrapTag.tag, commitSha: resolved.commitSha, source: 'bootstrap' };
}

function validateExistingRelease(release, tag, commitSha) {
  const problems = [];
  if (release.draft) problems.push('is still a draft');
  if (release.prerelease) problems.push('is marked as a prerelease');
  if (release.target_commitish !== commitSha) problems.push(`targets ${release.target_commitish ?? '<missing>'}, not ${commitSha}`);
  if (release.name !== `Campfire ${tag}`) problems.push('has an unexpected name');
  if (!release.body?.startsWith(`# Campfire ${tag}\n`)) problems.push('does not contain generated Campfire notes');
  if (!release.body?.includes('\n## Operational notes\n')) problems.push('is missing operational notes');
  if (!release.body?.includes('\n## Contributors\n')) problems.push('is missing contributors');
  if (problems.length > 0) {
    throw new ReleaseError(
      'EXISTING_RELEASE_MISMATCH',
      `An existing release owns ${tag} but is not the expected generated release: ${problems.join('; ')}.`,
      problems,
    );
  }
}

export async function collectChanges(api, baseSha, headSha, repositoryUrl) {
  const comparison = await api.compare(baseSha, headSha);
  if (comparison.merge_base_commit?.sha !== baseSha || !['ahead', 'identical'].includes(comparison.status)) {
    throw new ReleaseError('INVALID_RANGE', `${baseSha} is not an ancestor of ${headSha}.`);
  }
  if ((comparison.total_commits ?? comparison.commits.length) > comparison.commits.length) {
    throw new ReleaseError(
      'RANGE_TOO_LARGE',
      `Commit range contains ${comparison.total_commits} commits but GitHub returned only ${comparison.commits.length}; refusing incomplete notes.`,
    );
  }

  const pullRequests = new Map();
  const directCommits = [];
  const releasePrNumbers = new Set(
    (await api.listPullRequestsForCommit(headSha))
      .filter((pr) => pr.merged_at)
      .map((pr) => pr.number),
  );
  for (const commit of comparison.commits) {
    // The head commit is structurally verified as the version PR. Its package
    // bookkeeping is not a user-facing change and must not pollute the notes.
    if (commit.sha === headSha) continue;
    const associated = (await api.listPullRequestsForCommit(commit.sha))
      .filter((pr) => pr.merged_at && pr.merge_commit_sha && !releasePrNumbers.has(pr.number));
    if (associated.length === 0) {
      const title = commit.commit?.message?.split('\n')[0] ?? '';
      if (!/^merge\b/i.test(title) && !/^chore\(release\):/i.test(title) && !/^v\d+\.\d+\.\d+$/i.test(title)) {
        directCommits.push(normalizeCommitChange(commit, repositoryUrl));
      }
      continue;
    }
    for (const pr of associated) pullRequests.set(pr.number, normalizePullRequest(pr));
  }

  const changes = [...pullRequests.values(), ...directCommits];
  const issueNumbers = new Set(changes.flatMap((change) => change.closedIssueNumbers ?? []));
  const issues = [];
  for (const number of issueNumbers) {
    const issue = await api.getIssue(number);
    if (issue?.state === 'closed' && !issue.pull_request) issues.push(issue);
  }
  return { changes, issues };
}

export async function executeRelease({ api, config, tag, dryRun = false, repositoryUrl }) {
  parseReleaseTag(tag);
  const tagged = await resolveTag(api, tag, { requireAnnotated: true });
  const mainRef = await api.getRef(`heads/${config.mainBranch}`);
  if (!mainRef || mainRef.object?.type !== 'commit') {
    throw new ReleaseError('MISSING_MAIN', `Protected branch ${config.mainBranch} could not be resolved.`);
  }
  if (tagged.commitSha !== mainRef.object.sha) {
    throw new ReleaseError(
      'STALE_MAIN_TAG',
      `Tag ${tag} points to ${tagged.commitSha}, but protected ${config.mainBranch} currently points to ${mainRef.object.sha}. ` +
        'A release tag must target the exact protected-branch head selected by the release procedure.',
    );
  }
  await validateVersionsAtRef(api, tagged.commitSha, tag, config.versionSources);
  await validateReleaseCommit(api, tagged.commitSha, tag, config);
  verifyRequiredChecks(await api.listCheckRuns(tagged.commitSha), config.requiredChecks);

  const existing = await api.getReleaseByTag(tag);
  if (existing) {
    validateExistingRelease(existing, tag, tagged.commitSha);
    return { status: 'already-published', release: existing, tag, commitSha: tagged.commitSha, dryRun };
  }

  const previous = await selectPreviousValidRelease(api, tag, tagged.commitSha, config);
  const { changes, issues } = await collectChanges(api, previous.commitSha, tagged.commitSha, repositoryUrl);
  for (const change of changes) {
    change.closedIssueNumbers = extractClosingIssueNumbers(change.body);
  }
  const body = generateReleaseNotes({ tag, previousTag: previous.tag, changes, issues });
  const releaseInput = {
    tag_name: tag,
    target_commitish: tagged.commitSha,
    name: `Campfire ${tag}`,
    body,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  };
  if (dryRun) {
    return { status: 'dry-run', tag, commitSha: tagged.commitSha, previous, releaseInput, changes, issues };
  }

  try {
    const release = await api.createRelease(releaseInput);
    return { status: 'published', tag, commitSha: tagged.commitSha, previous, release };
  } catch (error) {
    if (error instanceof ReleaseError && error.status === 422) {
      const raced = await api.getReleaseByTag(tag);
      if (raced && !raced.draft) {
        validateExistingRelease(raced, tag, tagged.commitSha);
        return { status: 'already-published', release: raced, tag, commitSha: tagged.commitSha, dryRun: false };
      }
    }
    throw error;
  }
}

function repositoryParts(value) {
  const parts = value?.split('/');
  if (parts?.length !== 2 || parts.some((part) => !part)) {
    throw new ReleaseError('INVALID_ENVIRONMENT', 'GITHUB_REPOSITORY must be in owner/repository form.');
  }
  return parts;
}

async function main() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF_TYPE !== 'tag') {
      throw new ReleaseError('INVALID_EVENT', 'Release publishing only accepts a pushed tag event.');
    }
  }
  const dryRun = process.argv.includes('--dry-run');
  const tag = process.env.GITHUB_REF_NAME;
  const [owner, repo] = repositoryParts(process.env.GITHUB_REPOSITORY);
  if (!process.env.GITHUB_TOKEN) throw new ReleaseError('INVALID_ENVIRONMENT', 'GITHUB_TOKEN is required.');
  const configPath = new URL('./config.json', import.meta.url);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const api = new GitHubApi({
    owner,
    repo,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const result = await executeRelease({
    api,
    config,
    tag,
    dryRun,
    repositoryUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${owner}/${repo}`,
  });
  console.log(JSON.stringify({
    status: result.status,
    tag: result.tag,
    commitSha: result.commitSha,
    previousTag: result.previous?.tag,
    releaseUrl: result.release?.html_url,
    notes: dryRun ? result.releaseInput?.body : undefined,
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof ReleaseError ? error.code : 'UNEXPECTED_ERROR';
    console.error(`release-publisher: ${code}: ${error.message}`);
    process.exitCode = 1;
  });
}
