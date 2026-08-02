const fs = require('fs');
let content = fs.readFileSync('apps/web/src/features/encounters/TurnWorkspace.tsx', 'utf8');

const replacements = {
  "turn.isYourTurn ? 'It\\'s your turn.' : `Turn: ${turn.current?.name ?? 'Unknown'}`":
  "turn.isYourTurn ? t('workspace.yourTurn') : t('workspace.turnOf', { name: turn.current?.name ?? 'Unknown' })",

  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">Condition:</h3>":
  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.condition')}:</h3>",

  "<p className=\"text-sm text-muted m-0\">No conditions</p>":
  "<p className=\"text-sm text-muted m-0\">{t('workspace.noConditions')}</p>",

  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">Exhaustion</h3>":
  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.exhaustion')}</h3>",

  "placeholder=\"What is readied and what is the trigger?\"":
  "placeholder={t('workspace.readiedPlaceholder')}",

  "Set ready\n            </button>":
  "{t('workspace.setReady')}\n            </button>",

  "Clear ready\n              </button>":
  "{t('workspace.clearReady')}\n              </button>",

  "Readied: {currentTurnState.readied}":
  "{t('workspace.readiedLabel')}: {currentTurnState.readied}",

  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">Active effects</h3>":
  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.activeEffects')}</h3>",

  "{e.roundsRemaining} rd</span>}":
  "{e.roundsRemaining} {t('workspace.rd')}</span>}",

  "save: {e.saveAbility}":
  "{t('workspace.save')}: {e.saveAbility}",

  "remove\n                </button>":
  "{t('workspace.remove')}\n                </button>",

  "<h3 className=\"text-sm font-semibold text-white mb-1\">Start of turn</h3>":
  "<h3 className=\"text-sm font-semibold text-white mb-1\">{t('workspace.startOfTurn')}</h3>",

  "<h3 className=\"text-sm font-semibold text-white mb-1\">Before you end</h3>":
  "<h3 className=\"text-sm font-semibold text-white mb-1\">{t('workspace.beforeYouEnd')}</h3>",

  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">Suggested actions</h3>":
  "<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.suggestedActions')}</h3>",

  "placeholder=\"Search actions…\"":
  "placeholder={t('workspace.searchActions')}",

  "aria-label=\"Search suggested actions\"":
  "aria-label={t('workspace.searchActionsAria')}",

  "{ id: ActionGroup.Attack, label: 'Attacks' },":
  "{ id: ActionGroup.Attack, label: t('workspace.tabs.attacks') },",

  "{ id: ActionGroup.Spell, label: 'Spells' },":
  "{ id: ActionGroup.Spell, label: t('workspace.tabs.spells') },",

  "{ id: ActionGroup.Feature, label: 'Features' },":
  "{ id: ActionGroup.Feature, label: t('workspace.tabs.features') },",

  "{ id: ActionGroup.Utility, label: 'Utility' }":
  "{ id: ActionGroup.Utility, label: t('workspace.tabs.utility') }",

  "targetCount > 0 ? `${targetCount} target${targetCount > 1 ? 's' : ''}` : 'AoE';":
  "targetCount > 0 ? t('workspace.targets', { count: targetCount }) : t('workspace.aoe');",

  "Use\n                    </button>":
  "{t('workspace.use')}\n                    </button>",

  ">No matching actions.</p>":
  ">{t('workspace.noMatchingActions')}</p>",

  "{turn.isYourTurn ? 'End my turn →' : 'End turn →'}":
  "{turn.isYourTurn ? t('workspace.endMyTurn') : t('workspace.endTurn')}",

  ">The DM advances turns in this campaign.</span>":
  ">{t('workspace.dmAdvancesTurns')}</span>",

  ">Ending your turn will ask the DM to confirm.</span>":
  ">{t('workspace.endingTurnAsksDm')}</span>"
};

for (const [key, value] of Object.entries(replacements)) {
  content = content.replace(key, value);
}

fs.writeFileSync('apps/web/src/features/encounters/TurnWorkspace.tsx', content);
console.log("Done");
