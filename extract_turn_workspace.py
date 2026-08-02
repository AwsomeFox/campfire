import re

with open('apps/web/src/features/encounters/TurnWorkspace.tsx', 'r') as f:
    content = f.read()

replacements = [
    (r"turn.isYourTurn \? 'It\\'s your turn.' : `Turn: \$\{turn.current\?.name \?\? 'Unknown'\}`", r"turn.isYourTurn ? t('workspace.yourTurn') : t('workspace.turnOf', { name: turn.current?.name ?? 'Unknown' })"),
    (r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">Condition:</h3>", r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.condition')}:</h3>"),
    (r"<p className=\"text-sm text-muted m-0\">No conditions</p>", r"<p className=\"text-sm text-muted m-0\">{t('workspace.noConditions')}</p>"),
    (r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">Exhaustion</h3>", r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.exhaustion')}</h3>"),
    (r"placeholder=\"What is readied and what is the trigger\?\"", r"placeholder={t('workspace.readiedPlaceholder')}"),
    (r">(\s*)Set ready(\s*)</button>", r">\1{t('workspace.setReady')}\2</button>"),
    (r">(\s*)Clear ready(\s*)</button>", r">\1{t('workspace.clearReady')}\2</button>"),
    (r"Readied: \{currentTurnState.readied\}", r"{t('workspace.readiedLabel')}: {currentTurnState.readied}"),
    (r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">Active effects</h3>", r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.activeEffects')}</h3>"),
    (r"\{e.roundsRemaining\} rd", r"{e.roundsRemaining} {t('workspace.rd')}"),
    (r"save: \{e.saveAbility\}", r"{t('workspace.save')}: {e.saveAbility}"),
    (r">(\s*)remove(\s*)</button>", r">\1{t('workspace.remove')}\2</button>"),
    (r"<h3 className=\"text-sm font-semibold text-white mb-1\">Start of turn</h3>", r"<h3 className=\"text-sm font-semibold text-white mb-1\">{t('workspace.startOfTurn')}</h3>"),
    (r"<h3 className=\"text-sm font-semibold text-white mb-1\">Before you end</h3>", r"<h3 className=\"text-sm font-semibold text-white mb-1\">{t('workspace.beforeYouEnd')}</h3>"),
    (r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">Suggested actions</h3>", r"<h3 className=\"text-sm font-semibold text-white mb-1.5\">{t('workspace.suggestedActions')}</h3>"),
    (r"placeholder=\"Search actions…\"", r"placeholder={t('workspace.searchActions')}"),
    (r"aria-label=\"Search suggested actions\"", r"aria-label={t('workspace.searchActionsAria')}"),
    (r"\{ id: ActionGroup.Attack, label: 'Attacks' \}", r"{ id: ActionGroup.Attack, label: t('workspace.tabs.attacks') }"),
    (r"\{ id: ActionGroup.Spell, label: 'Spells' \}", r"{ id: ActionGroup.Spell, label: t('workspace.tabs.spells') }"),
    (r"\{ id: ActionGroup.Feature, label: 'Features' \}", r"{ id: ActionGroup.Feature, label: t('workspace.tabs.features') }"),
    (r"\{ id: ActionGroup.Utility, label: 'Utility' \}", r"{ id: ActionGroup.Utility, label: t('workspace.tabs.utility') }"),
    (r"targetCount > 0 \? `\$\{targetCount\} target\$\{targetCount > 1 \? 's' : ''\}` : 'AoE'", r"targetCount > 0 ? t('workspace.targets', { count: targetCount }) : t('workspace.aoe')"),
    (r">(\s*)Use(\s*)</button>", r">\1{t('workspace.use')}\2</button>"),
    (r">No matching actions.</p>", r">{t('workspace.noMatchingActions')}</p>"),
    (r"\{turn.isYourTurn \? 'End my turn →' : 'End turn →'\}", r"{turn.isYourTurn ? t('workspace.endMyTurn') : t('workspace.endTurn')}"),
    (r">The DM advances turns in this campaign.</span>", r">{t('workspace.dmAdvancesTurns')}</span>"),
    (r">Ending your turn will ask the DM to confirm.</span>", r">{t('workspace.endingTurnAsksDm')}</span>"),
]

for pattern, repl in replacements:
    content = re.sub(pattern, repl, content)

with open('apps/web/src/features/encounters/TurnWorkspace.tsx', 'w') as f:
    f.write(content)

print("Done")
