const fs = require('fs');

let w = fs.readFileSync('apps/web/src/features/encounters/GenerateEncounterWizard.tsx', 'utf8');
w = w.replace(/onCount: \(count: number\) => void;\n\}\) \{/, (match) => {
  return match + "\n  const { t } = useTranslation('encounters');";
});
fs.writeFileSync('apps/web/src/features/encounters/GenerateEncounterWizard.tsx', w);
