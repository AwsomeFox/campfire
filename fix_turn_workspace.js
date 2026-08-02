const fs = require('fs');
let content = fs.readFileSync('apps/web/src/features/encounters/TurnWorkspace.tsx', 'utf8');

content = content.replace(/turn\.isYourTurn \? 'It\\'s your turn\.' : `Turn: \$\{turn\.current\?\.name \?\? 'Unknown'\}`/, "turn.isYourTurn ? t('workspace.yourTurn') : t('workspace.turnOf', { name: turn.current?.name ?? 'Unknown' })");
content = content.replace(/<h3 className="text-sm font-semibold text-white mb-1.5">Condition:<\/h3>/, '<h3 className="text-sm font-semibold text-white mb-1.5">{t(\'workspace.condition\')}:</h3>');
content = content.replace(/<p className="text-sm text-muted m-0">No conditions<\/p>/, '<p className="text-sm text-muted m-0">{t(\'workspace.noConditions\')}</p>');
content = content.replace(/<h3 className="text-sm font-semibold text-white mb-1.5">Exhaustion<\/h3>/, '<h3 className="text-sm font-semibold text-white mb-1.5">{t(\'workspace.exhaustion\')}</h3>');
content = content.replace(/placeholder="What is readied and what is the trigger\?"/, 'placeholder={t(\'workspace.readiedPlaceholder\')}');
content = content.replace(/Set ready/, '{t(\'workspace.setReady\')}');
content = content.replace(/Clear ready/, '{t(\'workspace.clearReady\')}');
content = content.replace(/Readied: \{currentTurnState.readied\}/, '{t(\'workspace.readiedLabel\')}: {currentTurnState.readied}');

fs.writeFileSync('apps/web/src/features/encounters/TurnWorkspace.tsx', content);
console.log("Done");
