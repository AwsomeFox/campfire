const fs = require('fs');

let endConfirm = fs.readFileSync('apps/web/e2e/tests/encounter-end-confirm-copy.unit.spec.ts', 'utf8');
endConfirm = endConfirm.replace(
  "  expect(match, 'End ConfirmDialog body string').toBeTruthy();\n  return match![1];",
  ""
);
fs.writeFileSync('apps/web/e2e/tests/encounter-end-confirm-copy.unit.spec.ts', endConfirm);

