# Releasing Campfire

Campfire's release cadence is deliberately human-controlled. Repository automation
does **not** count merged pull requests, decide that a release is due, open a version
pull request, change a version, or create a tag. After roughly ten merges, the lead
decides whether to prepare the next patch release.

## Manual release procedure

1. Inspect `main`, the previous valid GitHub Release, and the changes since it.
2. Open a normal patch-version pull request. It must set the same version in:
   `package.json`, every workspace `package.json`, and the root and workspace entries
   in `package-lock.json`. The server runtime reads `apps/server/package.json`; the
   signed-out UI build reads `apps/web/package.json`, so neither may drift.
3. Merge the version pull request normally. Do not tag the feature commit before it
   and do not tag a later commit.
4. Wait for all required CI checks on the exact merge commit: `lint`, `build-test`,
   `coverage`, `e2e-web`, and `release-automation`.
5. Verify the commit is on `origin/main`, then deliberately create and push one
   **annotated** stable SemVer tag:

   ```bash
   git fetch origin main
   release_sha="$(git rev-parse origin/main)"
   git tag -a vX.Y.Z "$release_sha" -m "vX.Y.Z"
   git push origin refs/tags/vX.Y.Z
   ```

The pushed tag is the only release trigger. `.github/workflows/release.yml` first
runs a non-mutating validation and notes preview. It then publishes the versioned and
`latest` container images and, finally, creates one non-draft GitHub Release. A retry
finds the existing release by tag instead of creating a duplicate.

## What validation rejects

The publisher fails closed unless all of these are true:

- the ref is an annotated tag whose name is exactly `vX.Y.Z` (no prerelease suffix);
- the tagged commit is an ancestor of protected `main`;
- all configured package, workspace, lockfile, server-runtime, and web-UI version
  values equal `X.Y.Z`;
- the tagged commit itself changed every version metadata file, making it the version
  commit rather than a stale later commit;
- every configured GitHub Actions check succeeded on that exact commit;
- the previous baseline is either a valid non-draft GitHub Release on the same
  ancestry or the explicitly pinned bootstrap in `.github/release/config.json`.

An older tag is never guessed as a baseline merely because its name looks like a
version. A released baseline must still have a tag, be on the new tag's ancestry, and
contain synchronized version metadata.

Generated notes de-duplicate merged pull requests, link explicitly closed issues,
group security, accessibility, bug fixes, features, polish, testing, and documentation,
list contributors, and surface migration, configuration, compatibility, and known-
limitation signals from pull-request metadata.

## Recovery for the divergent `v0.14.1` tag

`v0.14.1` is historical divergent state and must not be published or reused:

- annotated tag object: `2fccc3f102d636fdcd11bf838b247c7837d4b01d`;
- tagged commit: `c75dbdecf467b312dd05ec02c8750e8a31e2ca4e`;
- that commit is not an ancestor of current `main`;
- its package manifests say `0.14.1`, while its lockfile entries still say `0.14.0`.

Confirm the diagnosis without changing anything:

```bash
git fetch origin main --tags
git rev-parse 'v0.14.1^{commit}'
git merge-base --is-ancestor 'v0.14.1^{commit}' origin/main
# The last command must exit non-zero for the known divergent tag.
```

Recovery is forward-only:

1. Leave `v0.14.1` un-released; do not force-move or reuse it.
2. Prepare the next patch (`v0.14.2`) through the normal version pull request, making
   all package and lockfile values `0.14.2`.
3. Wait for required CI on that exact `main` commit.
4. Create and push the annotated `v0.14.2` tag manually.

Until a valid GitHub Release exists, release notes start from the explicit `v0.14.0`
bootstrap pinned to commit `2bf2303ff73573819d006b9c7f95ee99ef30d1e0`.
The publisher verifies both the tag and pinned commit before using it, so the
divergent `v0.14.1` history cannot be selected accidentally.

## Failed-run recovery

- A validation failure creates no image and no GitHub Release. Fix metadata or CI in
  a new version PR and use a new patch version; do not move an already pushed tag.
- If image or GitHub API publishing fails transiently, rerun the same workflow. Image
  publication is content-addressed, and release creation is idempotent by tag.
- If a draft or conflicting hand-made release already owns the tag, the publisher
  stops. The lead must inspect and resolve it manually before retrying.
- The workflow token is least-privilege: validation reads contents, checks, issues,
  and pull requests; the image job alone writes packages; the final job alone writes
  repository contents to create the Release.
