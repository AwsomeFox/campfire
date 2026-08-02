const fs = require('fs');
let content = fs.readFileSync('apps/web/src/features/encounters/RunSessionPage.tsx', 'utf8');

// Find imports
if (!content.includes('useTranslation(')) {
  content = content.replace(
    /import \{ useState, useEffect, useRef, useMemo, useCallback \} from 'react';/,
    "import { useState, useEffect, useRef, useMemo, useCallback } from 'react';\nimport { useTranslation } from 'react-i18next';"
  );
  content = content.replace(
    /export function RunSessionPage\(\) \{/,
    "export function RunSessionPage() {\n  const { t } = useTranslation('encounters');"
  );
}

// Lifecycle verbs
content = content.replace(/Roll initiative/g, "{t('run.rollInitiative')}");
content = content.replace(/>Start</g, ">{t('run.start')}<");
content = content.replace(/Next turn →/g, "{t('run.nextTurn')}");
content = content.replace(/>End</g, ">{t('run.end')}<");
content = content.replace(/>Reopen</g, ">{t('run.reopen')}<");
content = content.replace(/title="End this encounter\?"/g, "title={t('run.endDialog.title')}");
content = content.replace(/body="Ends the fight and writes each character combatant's HP, temp HP, and death state back to their sheets. You can Reopen later to resume where combat left off. If sheets heal or rest after this End, Reopen will show the conflict and ask which HP to keep — it will not silently overwrite."/g, "body={t('run.endDialog.body')}");
content = content.replace(/confirmLabel="End encounter"/g, "confirmLabel={t('run.endDialog.confirm')}");
content = content.replace(/pendingLabel="Ending encounter…"/g, "pendingLabel={t('run.endDialog.pending')}");

content = content.replace(/title="Reopen this encounter\?"/g, "title={t('run.reopenDialog.title')}");
content = content.replace(/It returns to Running where combat left off. Character sheets were synced when it\s+ended — if a sheet has healed, rested, or otherwise changed since then, choose which\s+HP to keep before reopening\./g, "{t('run.reopenDialog.body')}");
content = content.replace(/No sheet HP conflicts — combatant snapshots still match the sheets\./g, "{t('run.reopenDialog.noConflicts')}");
content = content.replace(/Reopen encounter/g, "{t('run.reopenDialog.confirm')}");
content = content.replace(/Reopening…/g, "{t('run.reopenDialog.pending')}");

content = content.replace(/Add combatant/g, "{t('run.addCombatant')}");
content = content.replace(/Add manually, search monsters and hazards, or drop a compendium monster\/hazard here\./g, "{t('run.addCombatantHint')}");

fs.writeFileSync('apps/web/src/features/encounters/RunSessionPage.tsx', content);
console.log("Done");
