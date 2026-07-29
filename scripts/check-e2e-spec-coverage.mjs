#!/usr/bin/env node
/** Issue #1453: ensure the browserless unit tier is neither orphaned nor duplicated. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const webDir = join(root, 'apps/web');
const testsDir = join(webDir, 'e2e/tests');
const unitConfig = 'playwright.unit.config.ts';
const unitSpec = /\.unit\.spec\.(?:[cm]?[jt]s)$/;
const supportedUnitSpec = /\.unit\.spec\.m?ts$/;
const browserUnitIgnore = /^\s*testIgnore:\s*\/\.\*\\\.unit\\\.spec\\\.m\?ts\//m;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : unitSpec.test(entry.name) ? [path] : [];
  });
}

function playwrightCli() {
  const req = createRequire(join(webDir, 'package.json'));
  const pkgPath = req.resolve('@playwright/test/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright;
  if (!bin) throw new Error('@playwright/test has no playwright CLI bin');
  return join(dirname(pkgPath), bin);
}

function listedUnitFiles() {
  const output = execFileSync(
    process.execPath,
    [playwrightCli(), 'test', '--list', '--config', unitConfig, '--reporter', 'json'],
    { cwd: webDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const data = JSON.parse(output);
  if (data.errors?.length) throw new Error(`Playwright collection failed: ${data.errors.map((e) => e.message).join('; ')}`);
  const files = new Set();
  for (const suite of data.suites ?? []) if (suite.file) files.add(resolve(data.config.rootDir, suite.file));
  return files;
}

function main() {
  const webPackage = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8'));
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const browserConfig = readFileSync(join(webDir, 'playwright.config.ts'), 'utf8');
  const jobBlock = (name) => {
    const match = ci.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'));
    return match?.[1] ?? '';
  };
  const errors = [];
  if (webPackage.scripts?.['test:unit'] !== `playwright test --config ${unitConfig}`) errors.push(`apps/web test:unit must invoke ${unitConfig}`);
  if (!rootPackage.scripts?.['test:all']?.includes('test:unit:web')) errors.push('root test:all must invoke test:unit:web');
  const unitWeb = jobBlock('unit-web');
  const aggregateCi = jobBlock('ci');
  const unitStep = unitWeb.match(/^      - name: Run web unit specs\n((?:        .*\n)*)/m)?.[1] ?? '';
  if (!/^        run: npm run test:unit -w apps\/web$/m.test(unitStep) || /^        if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/m.test(unitStep)) errors.push('CI unit-web job must run web test:unit without a statically disabled condition');
  if (!/needs:\s*\[[^\]]*unit-web/.test(aggregateCi)) errors.push('aggregate ci must depend on unit-web');
  if (!browserUnitIgnore.test(browserConfig)) errors.push('browser Playwright config must retain testIgnore: /.*\\.unit\\.spec\\.m?ts/ so supported unit specs cannot run in both tiers');

  const onDisk = new Set(walk(testsDir));
  for (const file of onDisk) {
    if (!supportedUnitSpec.test(file)) {
      errors.push(`${relative(testsDir, file)} must use .unit.spec.ts or .unit.spec.mts; JavaScript unit specs are also collected by the browser tier`);
    }
  }
  if (!errors.length) {
    const listed = listedUnitFiles();
    for (const file of onDisk) if (!listed.has(file)) errors.push(`${relative(testsDir, file)} is not collected by ${unitConfig}`);
    for (const file of listed) if (!onDisk.has(file) && file.startsWith(`${testsDir}/`)) errors.push(`${relative(testsDir, file)} is collected but is not a unit spec`);
  }
  if (errors.length) {
    console.error(`check:e2e-spec-coverage failed:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`check:e2e-spec-coverage: OK — ${onDisk.size} unit spec file(s) collected by Playwright and enforced by unit-web/ci.`);
}

main();
