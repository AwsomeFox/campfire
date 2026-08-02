const fs = require('fs');
const encountersPath = 'apps/web/src/i18n/locales/en/encounters.json';
const data = JSON.parse(fs.readFileSync(encountersPath, 'utf8'));

data.encounters.actionFlow = {
  "noTargets": "No legal targets."
};

data.encounters.checks = {
  "requestCheck": "Request a check",
  "character": "Character",
  "chooseCharacter": "Choose a character…",
  "check": "Check",
  "chooseCheck": "Choose a check…",
  "pickCharacterFirst": "Pick a character first",
  "dc": "DC",
  "consequenceOptional": "Consequence (optional)",
  "rolled": "Rolled ",
  "consequence": "Consequence: "
};

data.encounters.wizard = {
  "step1": "1. Parameters",
  "step2": "2. Roster",
  "step3": "3. Save encounter",
  "noCreatures": "No creatures — adjust the filters and regenerate, or add one.",
  "none": "— none —",
  "noStatblock": "No statblock detail — HP/CR may be incomplete."
};

fs.writeFileSync(encountersPath, JSON.stringify(data, null, 2) + '\n');
console.log("i18n updated");
