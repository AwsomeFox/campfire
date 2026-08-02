const fs = require('fs');

let a11y = fs.readFileSync('apps/web/e2e/tests/encounter-a11y.unit.spec.ts', 'utf8');
a11y = a11y.replace(/aria-label="Add combatant"/, "aria-label=\\{t\\('run.addCombatant'\\)\\}");
fs.writeFileSync('apps/web/e2e/tests/encounter-a11y.unit.spec.ts', a11y);

let endConfirm = fs.readFileSync('apps/web/e2e/tests/encounter-end-confirm-copy.unit.spec.ts', 'utf8');
endConfirm = endConfirm.replace(
  /const match = source\.match\(\n\s*\/title="End this encounter\\\?"\\s\*body="\(\[\^"\]\+\)"\/,\n\s*\);/,
  "const bodyMatch = source.match(/body=\\{t\\('run.endDialog.body'\\)\\}/);\n  expect(bodyMatch, 'End ConfirmDialog body string').toBeTruthy();\n  // To test the exact English copy, read the locale JSON\n  const enLocale = JSON.parse(readFileSync(resolve(__dirname, '../../src/i18n/locales/en/encounters.json'), 'utf8'));\n  return enLocale.encounters.run.endDialog.body;"
);
fs.writeFileSync('apps/web/e2e/tests/encounter-end-confirm-copy.unit.spec.ts', endConfirm);

let reopenConfirm = fs.readFileSync('apps/web/e2e/tests/encounter-reopen-confirm-copy.unit.spec.ts', 'utf8');
reopenConfirm = reopenConfirm.replace(/expect\(source\)\.toMatch\(\/title="Reopen this encounter\\\?"\/\);/, "expect(source).toMatch(/title=\\{t\\('run.reopenDialog.title'\\)\\}/);");
reopenConfirm = reopenConfirm.replace(/expect\(source\)\.toMatch\(\/choose which\\s\*\\n\?\\s\*HP to keep\/i\);/, "");
reopenConfirm = reopenConfirm.replace(/expect\(source\)\.not\.toMatch\(\/silently overwritten\/\);/, "const enLocale = JSON.parse(readFileSync(resolve(__dirname, '../../src/i18n/locales/en/encounters.json'), 'utf8'));\n    const body = enLocale.encounters.run.reopenDialog.body;\n    expect(body).toMatch(/choose which\\s*\\n?\\s*HP to keep/i);\n    expect(body).not.toMatch(/silently overwritten/);");
fs.writeFileSync('apps/web/e2e/tests/encounter-reopen-confirm-copy.unit.spec.ts', reopenConfirm);

console.log("Done");
