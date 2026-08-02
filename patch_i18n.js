const fs = require('fs');

const encountersPath = 'apps/web/src/i18n/locales/en/encounters.json';
const data = JSON.parse(fs.readFileSync(encountersPath, 'utf8'));

data.encounters.workspace = {
  "yourTurn": "It's your turn.",
  "turnOf": "Turn: {{name}}",
  "condition": "Condition",
  "noConditions": "No conditions",
  "exhaustion": "Exhaustion",
  "readiedPlaceholder": "What is readied and what is the trigger?",
  "setReady": "Set ready",
  "clearReady": "Clear ready",
  "readiedLabel": "Readied",
  "activeEffects": "Active effects",
  "rd": "rd",
  "save": "save",
  "remove": "remove",
  "startOfTurn": "Start of turn",
  "beforeYouEnd": "Before you end",
  "suggestedActions": "Suggested actions",
  "searchActions": "Search actions…",
  "searchActionsAria": "Search suggested actions",
  "tabs": {
    "attacks": "Attacks",
    "spells": "Spells",
    "features": "Features",
    "utility": "Utility"
  },
  "targets": "{{count}} target",
  "targets_other": "{{count}} targets",
  "aoe": "AoE",
  "use": "Use",
  "noMatchingActions": "No matching actions.",
  "endMyTurn": "End my turn →",
  "endTurn": "End turn →",
  "dmAdvancesTurns": "The DM advances turns in this campaign.",
  "endingTurnAsksDm": "Ending your turn will ask the DM to confirm."
};

fs.writeFileSync(encountersPath, JSON.stringify(data, null, 2) + '\n');
console.log("i18n updated");
