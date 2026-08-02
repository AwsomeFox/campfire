const fs = require('fs');

function injectT(file, componentRegex) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes('useTranslation(')) {
    content = "import { useTranslation } from 'react-i18next';\n" + content;
  }
  content = content.replace(componentRegex, (match) => {
    return match + "\n  const { t } = useTranslation('encounters');";
  });
  fs.writeFileSync(file, content);
}

injectT('apps/web/src/features/encounters/ActionUseFlow.tsx', /export function ActionUsePanel\(\{[^}]+\}\: [^\{]+\{/);
injectT('apps/web/src/features/encounters/CheckRequests.tsx', /export function CheckRequestPanel\(\{[^}]+\}\: [^\{]+\{/);
injectT('apps/web/src/features/encounters/CheckRequests.tsx', /export function CheckRequestPrompts\(\{[^}]+\}\: [^\{]+\{/);
injectT('apps/web/src/features/encounters/GenerateEncounterWizard.tsx', /export function GenerateEncounterWizard\(\{[^}]+\}\: [^\{]+\{/);

let w = fs.readFileSync('apps/web/src/features/encounters/GenerateEncounterWizard.tsx', 'utf8');
w = w.replace(/>1\. Parameters</g, ">{t('wizard.step1')}<");
w = w.replace(/>2\. Roster</g, ">{t('wizard.step2')}<");
w = w.replace(/>3\. Save encounter</g, ">{t('wizard.step3')}<");
w = w.replace(/>No creatures — adjust the filters and regenerate, or add one\.</g, ">{t('wizard.noCreatures')}<");
w = w.replace(/>— none —</g, ">{t('wizard.none')}<");
w = w.replace(/>No statblock detail — HP\/CR may be incomplete\.</g, ">{t('wizard.noStatblock')}<");
fs.writeFileSync('apps/web/src/features/encounters/GenerateEncounterWizard.tsx', w);

let cr = fs.readFileSync('apps/web/src/features/encounters/CheckRequests.tsx', 'utf8');
cr = cr.replace(/>Request a check</g, ">{t('checks.requestCheck')}<");
cr = cr.replace(/>Choose a character…</g, ">{t('checks.chooseCharacter')}<");
cr = cr.replace(/>Choose a check…</g, ">{t('checks.chooseCheck')}<");
cr = cr.replace(/>Pick a character first</g, ">{t('checks.pickCharacterFirst')}<");
cr = cr.replace(/>Consequence \(optional\)</g, ">{t('checks.consequenceOptional')}<");
cr = cr.replace(/>Character</g, ">{t('checks.character')}<");
cr = cr.replace(/>Check</g, ">{t('checks.check')}<");
cr = cr.replace(/>DC</g, ">{t('checks.dc')}<");
fs.writeFileSync('apps/web/src/features/encounters/CheckRequests.tsx', cr);

