# Building with Campfire

Campfire is the UI of a self-hosted tabletop-RPG campaign tracker: **dark-only**,
Inter for text, Fraunces for display headings, a blurple accent.

## Setup

No theme provider is required. `styles.css` puts the palette on `:root` and sets
`body { background: var(--color-bg); color: var(--color-text); font-family: var(--font-body) }`,
so components are correctly styled as soon as that stylesheet is loaded. **Do not
add a light background to the page** — every colour here assumes a dark surface.

Some components read app context and must be wrapped when you use them:

- react-router (`<MemoryRouter>` / `<BrowserRouter>`) — anything with a link
  target: `EntityCard`, `ListDetailLink`, `PageHeader`, `DetailPageWayfinding`.
- react-query (`<QueryClientProvider>`) — anything that loads its own data:
  `CatchUpPanel`, `AiModeBadge`, `SafetyHoldBar`, `CharacterStatCard`.

```jsx
<div style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}>
  <PageTitle>The Sunken Crown</PageTitle>
  <Card>
    <Chip variant="active">Active</Chip>
    <Btn>Roll initiative</Btn>
  </Card>
</div>
```

## Styling idiom

Three layers, in order of preference:

1. **Use a component.** Reach for `Btn`, `Card`, `Chip`, `Dialog`, `TextInput`,
   `TextArea`, `EmptyState`, `ErrorNote`, `Skeleton`, `HpBar` before styling
   anything yourself.
2. **`cf-*` component classes** when you need the look on your own markup.
   The real families (121 classes ship; these are the load-bearing ones):

   | Family | Members |
   |---|---|
   | Button | `cf-btn`, `cf-btn-ghost`, `cf-btn-danger` |
   | Card | `cf-card`, `cf-card-flush`, `cf-card-hover` |
   | Chip | `cf-chip` + `cf-chip-{active,available,completed,failed,neutral,dm,party,private,whisper,proposal,ai}` |
   | Input | `cf-input` |
   | Muted text | `text-muted` |

3. **Tailwind v4 utilities + `var(--*)` tokens** for your own layout glue.

## Tokens

Semantic colours: `--color-bg`, `--color-surface`, `--color-text`,
`--color-text-secondary`, `--color-text-disabled`, `--color-text-timestamp`,
`--color-divider`, `--color-accent`, `--color-accent-2`, and the destructive set
`--color-danger`, `--color-danger-solid`, `--color-danger-border`.

Tonal ramps run `100`–`900` on one shared lightness scale, so the same step of
any role matches the others: `--color-neutral-*`, `--color-accent-*`,
`--color-accent-2-*`, `--color-amber-*`.

Type: `--font-body` (Inter), `--font-display` / `--font-heading` (Fraunces),
`--font-mono`, with sizes `--type-body`, `--type-reading`, `--type-supporting`,
`--type-control`, `--type-label`, `--type-meta`, `--type-kicker` and weights
`--font-weight-{normal,medium,semibold,bold,extrabold}`.

Radius is `--radius-sm` (4px) / `--radius-md` (8px) / `--radius-lg` (14px).

**Note:** Tailwind's spacing utilities (`p-3`, `gap-4`) use Tailwind's own scale,
*not* this system's `--space-*` tokens — the two are deliberately not bridged.
Use spacing utilities freely; just don't assume `p-3` equals `--space-3`.

## Where the truth lives

- `_ds/<folder>/styles.css` and its `@import` closure — the compiled palette,
  type, and every `cf-*` rule. Read it before inventing a class name.
- `components/<group>/<Name>/<Name>.prompt.md` — per-component usage.
- `components/<group>/<Name>/<Name>.d.ts` — the prop contract.

## Conventions worth keeping

- Secrecy is a first-class idea: `Chip variant="dm"` / `"private"` / `"whisper"`
  marks DM-only content. Don't invent your own "hidden" styling.
- Status vocabulary is fixed — active, available, completed, failed — and maps
  to chip variants of the same name.
- Controls keep a 44×44px touch target; `Btn` handles this via `density`.
