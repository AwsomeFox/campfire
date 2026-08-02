const fs = require('fs');
const encountersPath = 'apps/web/src/i18n/locales/en/encounters.json';
const data = JSON.parse(fs.readFileSync(encountersPath, 'utf8'));

data.encounters.run = {
  "rollInitiative": "Roll initiative",
  "start": "Start",
  "nextTurn": "Next turn →",
  "end": "End",
  "reopen": "Reopen",
  "endDialog": {
    "title": "End this encounter?",
    "body": "Ends the fight and writes each character combatant's HP, temp HP, and death state back to their sheets. You can Reopen later to resume where combat left off. If sheets heal or rest after this End, Reopen will show the conflict and ask which HP to keep — it will not silently overwrite.",
    "confirm": "End encounter",
    "pending": "Ending encounter…"
  },
  "reopenDialog": {
    "title": "Reopen this encounter?",
    "body": "It returns to Running where combat left off. Character sheets were synced when it ended — if a sheet has healed, rested, or otherwise changed since then, choose which HP to keep before reopening.",
    "noConflicts": "No sheet HP conflicts — combatant snapshots still match the sheets.",
    "confirm": "Reopen encounter",
    "pending": "Reopening…"
  },
  "addCombatant": "Add combatant",
  "addCombatantHint": "Add manually, search monsters and hazards, or drop a compendium monster/hazard here."
};

fs.writeFileSync(encountersPath, JSON.stringify(data, null, 2) + '\n');
console.log("i18n updated");
