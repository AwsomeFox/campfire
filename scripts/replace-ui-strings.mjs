#!/usr/bin/env node
/** Replace common hardcoded UI strings in #629 surfaces. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACE_ROOTS = [
  'apps/web/src/features/encounters',
  'apps/web/src/features/sessions',
  'apps/web/src/features/compendium',
  'apps/web/src/features/admin',
  'apps/web/src/features/session-zero',
];

const REPLACEMENTS = [
  [/title="Encounters"/g, "title={t('encounters.title')}"],
  [/title="No encounters yet"/g, "title={t('encounters.empty.title')}"],
  [/hint=\{isDm \? 'Start one when combat kicks off\.' : 'The DM hasn’t started one yet\.'\}/g,
    "hint={isDm ? t('encounters.empty.hintDm') : t('encounters.empty.hintPlayer')}"],
  [/message="Encounter not found\."/g, "message={t('encounters.notFoundDetail')}"],
  [/title="Encounter not found"/g, "title={t('encounters.notFound')}"],
  [/backLabel="← Back to encounters"/g, "backLabel={t('encounters.backToList')}"],
  [/setActionError\(makeActionError\(err instanceof ApiError \? err\.message : 'That action failed\.'\)\)/g,
    "setActionError(makeActionError(translateApiError(err, t, { fallbackKey: 'encounters.errors.actionFailed' })))"],
  [/EmptyState icon="padlock" title="You don't have access to this campaign"/g, "EmptyState icon=\"padlock\" title={t('sessions.accessDenied')}"],
  [/title="No users yet" hint="Create the first account above\."/g, "title={t('admin.empty.noUsers')} hint={t('admin.empty.noUsersHint')}"],
  [/title="No tokens yet" hint="Create one above to use the REST API or MCP\."/g, "title={t('admin.empty.noTokens')} hint={t('admin.empty.noTokensHint')}"],
  [/title="No rule packs installed" hint="Install one from a source below\."/g, "title={t('admin.empty.noRulePacks')} hint={t('admin.empty.noRulePacksHint')}"],
  [/title="No members yet" hint="Add one above\."/g, "title={t('admin.empty.noMembers')} hint={t('admin.empty.noMembersHint')}"],
  [/title="All campaigns have usable DM authority"/g, "title={t('admin.empty.noIntegrityIssues')}"],
  [/title="No activity yet"/g, "title={t('admin.empty.noActivity')}"],
  [/setError\("Couldn't load the schedule\."\)/g, "setError(t('sessions.errors.loadSchedule'))"],
  [/setError\("Couldn't load sessions\."\)/g, "setError(t('sessions.errors.loadSessions'))"],
  [/setError\("Couldn't save the recap\."\)/g, "setError(t('sessions.errors.saveRecap'))"],
  [/setError\("Couldn't reload the latest recap\."\)/g, "setError(t('sessions.errors.reloadRecap'))"],
  [/setError\("Couldn't delete the session\."\)/g, "setError(t('sessions.errors.deleteSession'))"],
  [/setError\("Couldn't load attendance\."\)/g, "setError(t('sessions.errors.loadAttendance'))"],
  [/setError\("Couldn't load the character roster\."\)/g, "setError(t('sessions.errors.loadRoster'))"],
  [/setError\("Couldn't save attendance\."\)/g, "setError(t('sessions.errors.saveAttendance'))"],
  [/setError\("Couldn't load share links\."\)/g, "setError(t('sessions.errors.loadShareLinks'))"],
  [/setError\("Couldn't create a share link\."\)/g, "setError(t('sessions.errors.createShareLink'))"],
  [/setError\("Couldn't publish the recap\."\)/g, "setError(t('sessions.errors.publishRecap'))"],
  [/setError\("Couldn't cancel the session\."\)/g, "setError(t('sessions.errors.cancelSession'))"],
  [/setError\("Couldn't update the session length\."\)/g, "setError(t('sessions.errors.updateSessionLength'))"],
  [/setError\("Couldn't load this recap\. Try again in a moment\."\)/g, "setError(t('sessions.errors.loadRecapRetry'))"],
  [/setError\("Couldn't load the session-zero charter\."\)/g, "setError(t('sessionZero.errors.load'))"],
  [/setError\("Couldn't save the charter\."\)/g, "setError(t('sessionZero.errors.save'))"],
  [/setError\(e instanceof ApiError \? e\.message : "Couldn't save your support preference\."\)/g, "setError(translateApiError(e, t, { fallbackKey: 'sessionZero.errors.saveSupport' }))"],
  [/setError\(e instanceof ApiError \? e\.message : "Couldn't delete your support preference\."\)/g, "setError(translateApiError(e, t, { fallbackKey: 'sessionZero.errors.deleteSupport' }))"],
  [/ErrorNote message="Couldn't load this campaign\. Check your connection and retry\."/g, "ErrorNote message={t('compendium.errors.loadCampaign')}"],
  [/EmptyState title="No sessions yet — add your first recap"/g, "EmptyState title={t('sessions.empty.noSessions')}"],
  [/EmptyState title="No sessions yet — add your first recap" hint="Use “\+ Add recap” to log your first session\."/g, "EmptyState title={t('sessions.empty.noSessions')} hint={t('sessions.empty.noSessionsHint')}"],
  [/EmptyState icon="open-book" title="Select a session" hint="Pick a recap from the timeline on the left\."/g, "EmptyState icon=\"open-book\" title={t('sessions.empty.selectSession')} hint={t('sessions.empty.selectSessionHint')}"],
  [/EmptyState icon="feather" title="No scribe runs yet" hint="Run it on demand, or turn on a sweep in Configure\."/g, "EmptyState icon=\"feather\" title={t('sessions.empty.noScribeRuns')} hint={t('sessions.empty.noScribeRunsHint')}"],
  [/onError\(job\.error \?\? "Couldn't install the rule pack\."\)/g, "onError(job.error ?? t('admin.errors.installPack'))"],
  [/return <EmptyState icon="shield" title="No members yet" \/>/g, "return <EmptyState icon=\"shield\" title={t('admin.empty.noMembers')} />"],
  [/return <EmptyState icon="scroll-unfurled" title="No activity yet" \/>/g, "return <EmptyState icon=\"scroll-unfurled\" title={t('admin.empty.noActivity')} />"],
  [/ErrorNote message="Entry not found\."/g, "ErrorNote message={t('compendium.notFound')}"],
  [/title="No session-zero charter yet"/g, "title={t('sessionZero.empty.title')}"],
];

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

let n = 0;
for (const relRoot of SURFACE_ROOTS) {
  for (const file of walk(join(root, relRoot))) {
    let src = readFileSync(file, 'utf8');
    const before = src;
    for (const [re, rep] of REPLACEMENTS) src = src.replace(re, rep);
    if (src !== before) {
      writeFileSync(file, src);
      n += 1;
      console.log('ui', file.slice(root.length + 1));
    }
  }
}
console.log(`replace-ui-strings: ${n} file(s)`);
