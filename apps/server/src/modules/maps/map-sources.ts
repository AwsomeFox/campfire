import type { MapSource } from '@campfire/schema';
import { isOpenLicense, licenseForbidsRedistribution } from '@campfire/schema';

/**
 * The curated "get a map" catalog for issue #303 — EXTERNAL open map sources that
 * complement the first-party procedural generator (#306).
 *
 * Why a hand-curated static list (not a fetched dataset): there is no clean bulk dataset
 * of open battle maps to import. Nearly every 'free' map pack (Angela Maps, ItsDaValen,
 * GM Craft Tavern, …) is CC-BY-NC-ND — no commercial use, no modification, no
 * redistribution — so Campfire can't legally bundle or re-serve them, and the
 * `isOpenLicense` gate correctly rejects them. Dyson Logos maps are free-for-commercial-use
 * but under a bespoke grant (not CC/OGL), which the gate also rejects — deliberately left
 * out rather than special-cased.
 *
 * Everything here is one of two license-clean shapes:
 *   1. a *generator* the DM runs themselves and imports the output of (Watabou, donjon) —
 *      we only LINK to it, never fetch/bundle, so no NC/ND content can enter this way; and
 *   2. the One Page Dungeon Contest (CC-BY-SA 3.0) — genuinely open, importable via the
 *      attributed-import path (which stamps the CC-BY-SA credit onto the stored map).
 */
export const OPEN_MAP_SOURCES: readonly MapSource[] = [
  {
    id: 'campfire-generator',
    name: 'Campfire map generator',
    kind: 'generator-builtin',
    description:
      'The built-in procedural battle-map generator. Pick a kind (dungeon, cave, wilderness), size, and seed; ' +
      'the map is saved grid-aligned and DM-only, ready to attach to an encounter. Fully offline and reproducible.',
    // No `url`: the built-in generator is the POST /campaigns/:id/maps/generate endpoint,
    // not an external site. The web client wires its button straight to that call.
    license: 'CC0 (generated in-app)',
    attributionRequired: false,
    goodFor: ['dungeon', 'cave', 'wilderness', 'battle map'],
    importable: false,
  },
  {
    id: 'watabou-one-page-dungeon',
    name: 'Watabou — One Page Dungeon',
    kind: 'generator-external',
    description:
      'Procedural one-page dungeon generator. Generate a layout, export it as an image, then import it below. ' +
      'Output is free to use (including commercially); the author only asks you not resell the raw exports as-is.',
    url: 'https://watabou.github.io/one-page-dungeon/',
    license: 'free for commercial use (attribution appreciated)',
    attributionRequired: false,
    goodFor: ['dungeon', 'battle map'],
    importable: false,
  },
  {
    id: 'watabou-city-generator',
    name: 'Watabou — Medieval Fantasy City',
    kind: 'generator-external',
    description:
      'Procedural medieval city/town map generator. Great for world/region and settlement layouts (less so tactical ' +
      'battle maps). Export an image and import it as a location map.',
    url: 'https://watabou.github.io/city-generator/',
    license: 'free for commercial use (attribution appreciated)',
    attributionRequired: false,
    goodFor: ['town', 'city', 'region'],
    importable: false,
  },
  {
    id: 'watabou-village-generator',
    name: 'Watabou — Village',
    kind: 'generator-external',
    description:
      'Procedural village generator for small settlements and hamlets. Export an image and import it as a location map.',
    url: 'https://watabou.github.io/village-generator/',
    license: 'free for commercial use (attribution appreciated)',
    attributionRequired: false,
    goodFor: ['village', 'town', 'region'],
    importable: false,
  },
  {
    id: 'donjon-fantasy-maps',
    name: 'donjon — Fantasy Maps',
    kind: 'generator-external',
    description:
      "donjon's suite of dungeon, world, and town generators built on OGL content. Generate a map, export it, and " +
      'import it. Best for world/region and dungeon layouts.',
    url: 'https://donjon.bin.sh/',
    license: 'OGL (generated content)',
    attributionRequired: false,
    goodFor: ['dungeon', 'world', 'town', 'region'],
    importable: false,
  },
  {
    id: 'one-page-dungeon-contest',
    name: 'One Page Dungeon Contest',
    kind: 'importable-collection',
    description:
      'Years of community one-page dungeons — map plus room/encounter notes, deliberately system-neutral — released ' +
      'under CC-BY-SA 3.0. Download an entry image and import it below; Campfire stamps the required CC-BY-SA credit ' +
      'onto the saved map. Quality varies and entries are images/PDFs (not structured data), so import one at a time.',
    url: 'https://www.dungeoncontest.com/',
    license: 'CC-BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    attributionRequired: true,
    goodFor: ['dungeon', 'adventure', 'battle map'],
    importable: true,
  },
];

// Invariant (issue #303): any source Campfire actually INGESTS (`importable`) must name a
// recognised open licence — the same `isOpenLicense` gate the rules importer uses (#19),
// so the attributed-import path can never bundle NC/ND content. External *generator* links
// are intentionally NOT subject to this gate: their output is generated client-side under a
// bespoke permissive grant (Watabou's "free for commercial use", donjon's OGL content) and
// is never fetched or re-served by Campfire, so the CC/OGL-keyword gate doesn't apply to the
// link itself. This asserts at module load, so a future edit that marks a non-open source
// `importable` fails the build/tests loudly.
for (const s of OPEN_MAP_SOURCES) {
  if (s.importable && (!isOpenLicense(s.license) || licenseForbidsRedistribution(s.license))) {
    throw new Error(
      `map-sources: importable source "${s.id}" has a non-redistributable license "${s.license}" — only openly-redistributable content (no NC/ND) may be imported (issue #303)`,
    );
  }
}

/** Look up a curated source by its stable id, or undefined if unknown. */
export function getMapSource(id: string): MapSource | undefined {
  return OPEN_MAP_SOURCES.find((s) => s.id === id);
}
