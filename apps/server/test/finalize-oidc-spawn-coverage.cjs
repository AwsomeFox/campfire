'use strict';

/**
 * Merges OIDC child-process V8 coverage saved during oidc.e2e-spec into
 * coverage/coverage-final.json, then enforces jest.config.js coverageThreshold.
 *
 * Spawn coverage is applied post-jest so v8-to-istanbul statement maps do not
 * trip istanbul-lib-source-maps during Jest's report phase (#556).
 */
const fs = require('node:fs');
const path = require('node:path');
const libCoverage = require('istanbul-lib-coverage');

const SERVER_ROOT = path.resolve(__dirname, '..');
const COVERAGE_FINAL = path.join(SERVER_ROOT, 'coverage', 'coverage-final.json');
const SNAPSHOT = path.join(SERVER_ROOT, 'coverage', 'oidc-spawn-cov-snapshot.json');
const OIDC_SERVICE_SOURCE = path.join(SERVER_ROOT, 'src', 'modules', 'auth', 'oidc.service.ts');
const jestConfig = require('../jest.config.js');

function isOidcServiceCoverageKey(file) {
  return file === OIDC_SERVICE_SOURCE || file.endsWith(`${path.sep}oidc.service.ts`);
}

function loadCoverageFinal() {
  if (!fs.existsSync(COVERAGE_FINAL)) {
    throw new Error(`missing ${COVERAGE_FINAL} — run jest --coverage first`);
  }
  return libCoverage.createCoverageMap(JSON.parse(fs.readFileSync(COVERAGE_FINAL, 'utf8')));
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return libCoverage.createCoverageMap({});
  return libCoverage.createCoverageMap(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
}

function checkThresholds(map) {
  const thresholds = jestConfig.coverageThreshold;
  if (!thresholds) return [];

  const errors = [];
  const files = map.files();

  for (const [group, groupThresholds] of Object.entries(thresholds)) {
    if (group === 'global') {
      const summary = map.getCoverageSummary().toJSON();
      errors.push(...compareThreshold('global', groupThresholds, summary));
      continue;
    }

    const resolvedGroup = path.resolve(group);
    const suffix =
      group.endsWith(path.sep) || (process.platform === 'win32' && group.endsWith('/'))
        ? path.sep
        : '';
    const groupPrefix = `${resolvedGroup}${suffix}`;
    const matched = files.filter(
      (file) => file.indexOf(groupPrefix) === 0 || file === resolvedGroup,
    );

    if (matched.length === 0) {
      errors.push(`Jest: Coverage data for ${group} was not found.`);
      continue;
    }

    const groupMap = libCoverage.createCoverageMap({});
    for (const file of matched) {
      groupMap.addFileCoverage(map.fileCoverageFor(file).toJSON());
    }
    errors.push(...compareThreshold(group, groupThresholds, groupMap.getCoverageSummary().toJSON()));
  }

  return errors;
}

function compareThreshold(name, thresholds, actuals) {
  const errors = [];
  for (const key of ['statements', 'branches', 'lines', 'functions']) {
    const threshold = thresholds[key];
    if (threshold === undefined) continue;
    const actual = actuals[key].pct;
    if (actual < threshold) {
      errors.push(
        `Jest: "${name}" coverage threshold for ${key} (${threshold}%) not met: ${actual}%`,
      );
    }
  }
  return errors;
}

function applySpawnSnapshot(map, snapshot) {
  const spawnFiles = snapshot.files().filter(isOidcServiceCoverageKey);
  if (spawnFiles.length === 0) return map;

  const data = map.toJSON();
  for (const file of Object.keys(data)) {
    if (isOidcServiceCoverageKey(file)) {
      delete data[file];
    }
  }
  for (const file of spawnFiles) {
    const entry = snapshot.fileCoverageFor(file).toJSON();
    const { all: _all, ...sanitized } = entry;
    data[file] = sanitized;
  }
  return libCoverage.createCoverageMap(data);
}

function main() {
  const snapshot = loadSnapshot();
  const map = applySpawnSnapshot(loadCoverageFinal(), snapshot);
  if (snapshot.files().length === 0) {
    console.warn('[oidc-cov] no spawn snapshot found — skipping post-merge');
  } else {
    fs.writeFileSync(COVERAGE_FINAL, JSON.stringify(map.toJSON(), null, 2));
    console.log(
      `[oidc-cov] applied spawn snapshot (${snapshot.files().join(', ')}) to coverage-final.json`,
    );
  }

  const errors = checkThresholds(map);
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(err);
    }
    process.exit(1);
  }
}

main();
