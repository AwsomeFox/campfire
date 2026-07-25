import type { DiceTheme } from '@campfire/schema';

export interface DiceThemeSpec {
  id: DiceTheme;
  nameKey: string;
  descKey: string;
  previewBg: string;
  previewBorder: string;
  previewText: string;
  previewGlow?: string;
}

export const DICE_THEMES: readonly DiceThemeSpec[] = [
  {
    id: 'nocturne',
    nameKey: 'dice.themes.nocturne.name',
    descKey: 'dice.themes.nocturne.desc',
    previewBg: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)',
    previewBorder: '1px solid #6366f1',
    previewText: '#e0e7ff',
    previewGlow: '0 0 12px rgba(99, 102, 241, 0.5)',
  },
  {
    id: 'obsidian_gold',
    nameKey: 'dice.themes.obsidian_gold.name',
    descKey: 'dice.themes.obsidian_gold.desc',
    previewBg: 'linear-gradient(135deg, #09090b 0%, #18181b 100%)',
    previewBorder: '1px solid #f59e0b',
    previewText: '#fbbf24',
    previewGlow: '0 0 14px rgba(245, 158, 11, 0.6)',
  },
  {
    id: 'arcane_amethyst',
    nameKey: 'dice.themes.arcane_amethyst.name',
    descKey: 'dice.themes.arcane_amethyst.desc',
    previewBg: 'linear-gradient(135deg, #3b0764 0%, #581c87 100%)',
    previewBorder: '1px solid #c084fc',
    previewText: '#f0abfc',
    previewGlow: '0 0 14px rgba(192, 132, 252, 0.6)',
  },
  {
    id: 'dragon_ruby',
    nameKey: 'dice.themes.dragon_ruby.name',
    descKey: 'dice.themes.dragon_ruby.desc',
    previewBg: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 100%)',
    previewBorder: '1px solid #ef4444',
    previewText: '#fca5a5',
    previewGlow: '0 0 14px rgba(239, 68, 68, 0.6)',
  },
  {
    id: 'celestial_pearl',
    nameKey: 'dice.themes.celestial_pearl.name',
    descKey: 'dice.themes.celestial_pearl.desc',
    previewBg: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    previewBorder: '1px solid #38bdf8',
    previewText: '#e0f2fe',
    previewGlow: '0 0 14px rgba(56, 189, 248, 0.6)',
  },
  {
    id: 'cyberpunk_neon',
    nameKey: 'dice.themes.cyberpunk_neon.name',
    descKey: 'dice.themes.cyberpunk_neon.desc',
    previewBg: 'linear-gradient(135deg, #030712 0%, #111827 100%)',
    previewBorder: '1px solid #06b6d4',
    previewText: '#22d3ee',
    previewGlow: '0 0 16px rgba(6, 182, 212, 0.8)',
  },
  {
    id: 'eldritch_void',
    nameKey: 'dice.themes.eldritch_void.name',
    descKey: 'dice.themes.eldritch_void.desc',
    previewBg: 'linear-gradient(135deg, #022c22 0%, #064e3b 100%)',
    previewBorder: '1px solid #10b981',
    previewText: '#6ee7b7',
    previewGlow: '0 0 14px rgba(16, 185, 129, 0.6)',
  },
  {
    id: 'mahogany_wood',
    nameKey: 'dice.themes.mahogany_wood.name',
    descKey: 'dice.themes.mahogany_wood.desc',
    previewBg: 'linear-gradient(135deg, #27120a 0%, #451a03 100%)',
    previewBorder: '1px solid #d97706',
    previewText: '#fde68a',
    previewGlow: '0 0 10px rgba(217, 119, 6, 0.4)',
  },
];

export function getDiceThemeSpec(id?: DiceTheme | null): DiceThemeSpec {
  if (!id) return DICE_THEMES[0];
  return DICE_THEMES.find((t) => t.id === id) ?? DICE_THEMES[0];
}
