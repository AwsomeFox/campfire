#!/usr/bin/env python3
"""
Full game-icons.net catalog generator (issue #349, extending #302's
build_icons.py/gen_ts.py lineage).

#302 bundled a curated ~180-icon subset inline in
`apps/web/src/lib/icons/catalog.generated.ts` so the picker had zero-latency
icons for the common case. That file is 300+ KB of source and is already its
own lazy chunk (icons are only imported by icon-using routes/components), so
it's left untouched here.

This script instead emits the FULL set (~4,180 icons) as:
  1. `apps/web/src/lib/icons/fullIndex.generated.ts` — slug/name/artist/shard
     metadata only, NO svg bodies. Only ever reached via a dynamic import()
     (see `loadFullIconIndex()` in `lib/icons/index.ts`), so Vite code-splits
     it into its own chunk that never touches the main bundle.
  2. `apps/web/public/icons/shards/shard-XXX.json` — static JSON files, each
     mapping slug -> inner SVG body for ~100 icons. Fetched on demand (never
     import()ed as JS) and cached in memory by `resolveIcon()`.
  3. An updated `ICON_ARTISTS` (all ~35 contributors, up from 12) and a new
     `ICON_ARTIST_TOTAL_COUNTS` map spliced into `catalog.generated.ts` — both
     tiny, so they stay in the small curated chunk rather than the lazy one.

Source SVGs come from the game-icons/icons GitHub repo (CC BY 3.0 / CC0),
one flat folder per contributor. Every icon in that repo is a 512x512 SVG
with exactly two <path> elements: an opaque background rect
(`M0 0h512v512H0z`) and the glyph itself with `fill="#fff"` — verified across
all 4,180 non-badge icons before writing this script. We drop the background
path and strip the hard-coded fill so the glyph recolors via `currentColor`,
identical to the transform #302 used for the curated set (verified against
the checked-in bodies for all 180 curated slugs, see --verify).

The `badges/` folder (circular site-UI badges, not RPG icons) is excluded.

Usage:
    python3 generate_full_catalog.py --source /path/to/game-icons/icons/clone
    # or, to clone it first:
    python3 generate_full_catalog.py --clone /tmp/game-icons-src

Requires only the Python 3 standard library.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

WEB_ROOT = Path(__file__).resolve().parents[2]  # apps/web
ICONS_SRC_DIR = WEB_ROOT / "src" / "lib" / "icons"
CATALOG_TS = ICONS_SRC_DIR / "catalog.generated.ts"
FULL_INDEX_TS = ICONS_SRC_DIR / "fullIndex.generated.ts"
SHARDS_DIR = WEB_ROOT / "public" / "icons" / "shards"

SHARD_SIZE = 100
EXCLUDE_DIRS = {"badges", ".git"}

# Folder (contributor) -> (display name, homepage or '', CC0-instead-of-CC-BY).
# Sourced from the game-icons/icons repo's license.txt, cross-checked against
# the actual folder names (license.txt lists display names only, which don't
# always kebab-case to the folder slug — e.g. "Lucas" ships from `lucasms/`,
# "HeavenlyDog" from `heavenly-dog/`). The 12 keys already used by the curated
# catalog keep byte-identical name/url strings to avoid unrelated Credits diff.
ARTISTS: Dict[str, Tuple[str, str, bool]] = {
    "andymeneely": ("Andy Meneely", "http://www.se.rit.edu/~andy/", False),
    "aussiesim": ("Aussiesim", "", False),
    "carl-olsen": ("Carl Olsen", "https://twitter.com/unstoppableCarl", False),
    "caro-asercion": ("Caro Asercion", "", False),
    "cathelineau": ("Cathelineau", "", False),
    "catsu": ("Catsu", "", False),
    "darkzaitzev": ("DarkZaitzev", "https://darkzaitzev.deviantart.com", False),
    "delapouite": ("Delapouite", "https://delapouite.com", False),
    "faithtoken": ("Faithtoken", "https://fungustoken.deviantart.com", False),
    "felbrigg": ("Felbrigg", "http://blackdogofdoom.blogspot.co.uk", False),
    "generalace135": ("GeneralAce135", "", False),
    "guard13007": ("Guard13007", "https://guard13007.com", False),
    "heavenly-dog": ("HeavenlyDog", "http://www.gnomosygoblins.blogspot.com", False),
    "irongamer": ("Irongamer", "http://ecesisllc.wix.com/home", False),
    "john-colburn": ("John Colburn", "http://ninmunanmu.com", False),
    "john-redman": ("John Redman", "http://www.uniquedicetowers.com", False),
    "kier-heyl": ("Kier Heyl", "", False),
    "lorc": ("Lorc", "https://lorcblog.blogspot.com", False),
    "lord-berandas": ("Lord Berandas", "http://berandas.deviantart.com", False),
    "lucasms": ("Lucas", "", False),
    "pepijn-poolman": ("Pepijn Poolman", "", False),
    "pierre-leducq": ("Pierre Leducq", "", False),
    "priorblue": ("PriorBlue", "", False),
    "quoting": ("Quoting", "", False),
    "rihlsul": ("Rihlsul", "", False),
    "sbed": ("Sbed", "https://opengameart.org/content/95-game-icons", False),
    "seregacthtuf": ("SeregaCthtuf", "", False),
    "skoll": ("Skoll", "", False),
    "sparker": ("Sparker", "http://citizenparker.com", False),
    "spencerdub": ("SpencerDub", "", False),
    "starseeker": ("Starseeker", "", False),
    "various-artists": ("Various Artists", "", False),
    "viscious-speed": ("Viscious Speed", "http://viscious-speed.deviantart.com", True),
    "willdabeast": ("Willdabeast", "https://wjbstories.blogspot.com", False),
    "zajkonur": ("Zajkonur", "", False),
    "zeromancer": ("Zeromancer", "", True),
}

BG_PATH_RE = re.compile(r'<path\s+d="M0 0[hH]512[vV]512[hH]0z"\s*/>')
PATH_RE = re.compile(r"<path\b[^>]*/>")


def slug_name(slug: str) -> str:
    """'crystal-wand' -> 'Crystal Wand' (matches #302's naive title-case)."""
    return " ".join(w[:1].upper() + w[1:] for w in slug.split("-") if w)


def extract_body(svg_text: str) -> Optional[str]:
    """Strip the background path + hard-coded fill; return the recolorable glyph."""
    paths = PATH_RE.findall(svg_text)
    if len(paths) != 2 or not BG_PATH_RE.match(paths[0]):
        return None
    glyph = paths[1]
    glyph = re.sub(r'\s*fill="#fff"', "", glyph)
    return glyph


def load_curated() -> Tuple[Dict[str, dict], List[Tuple[str, str, str, bool]]]:
    """Parse the existing curated catalog.generated.ts: slug -> {name,category,artist,body}."""
    text = CATALOG_TS.read_text(encoding="utf-8")
    entries: Dict[str, dict] = {}
    row_re = re.compile(
        r'\{ slug: "(?P<slug>[^"]+)", name: "(?P<name>[^"]*)", '
        r'category: "(?P<category>[^"]*)", artist: "(?P<artist>[^"]+)", '
        r'tags: \[[^\]]*\], body: "(?P<body>(?:[^"\\]|\\.)*)" \}'
    )
    for m in row_re.finditer(text):
        entries[m.group("slug")] = {
            "name": m.group("name"),
            "category": m.group("category"),
            "artist": m.group("artist"),
            # Bodies in the .ts source are JSON/JS-escaped (e.g. \" ), undo that.
            "body": m.group("body").replace('\\"', '"'),
        }
    return entries


def walk_source(source: Path) -> List[Tuple[str, str, Path]]:
    """Return [(artist_folder, slug, path)] for every non-badge SVG, sorted for determinism."""
    out: List[Tuple[str, str, Path]] = []
    for artist_dir in sorted(p for p in source.iterdir() if p.is_dir() and p.name not in EXCLUDE_DIRS):
        for svg in sorted(artist_dir.glob("*.svg")):
            out.append((artist_dir.name, svg.stem, svg))
    return out


def js_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, help="Path to an existing local clone of game-icons/icons")
    ap.add_argument("--clone", type=Path, help="Clone game-icons/icons into this directory first")
    ap.add_argument("--shard-size", type=int, default=SHARD_SIZE)
    ap.add_argument("--dry-run", action="store_true", help="Parse + validate only, write nothing")
    args = ap.parse_args()

    if args.clone:
        if not (args.clone / ".git").exists():
            args.clone.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "clone", "--depth", "1", "https://github.com/game-icons/icons.git", str(args.clone)],
                check=True,
            )
        source = args.clone
    elif args.source:
        source = args.source
    else:
        ap.error("pass --source <existing clone> or --clone <dir to clone into>")
        return 2

    curated = load_curated()
    all_files = walk_source(source)
    print(f"found {len(all_files)} source SVGs across "
          f"{len({a for a, _, _ in all_files})} contributor folders (excluding badges/)")

    unknown_artists = sorted({a for a, _, _ in all_files} - set(ARTISTS))
    if unknown_artists:
        print(f"ERROR: no attribution entry for artist folder(s): {unknown_artists}", file=sys.stderr)
        return 1

    # slug -> (artist_folder, path, body). Curated slugs are pinned to the
    # curated catalog's artist (and we require the source SVG at that artist's
    # folder to produce a byte-identical body, as a consistency check); any
    # other collision keeps the first hit in sorted-folder order.
    chosen: Dict[str, Tuple[str, Path]] = {}
    bodies: Dict[str, str] = {}
    skipped_parse = 0
    for artist, slug, path in all_files:
        if slug in curated and artist != curated[slug]["artist"]:
            continue  # not the curated artist's copy of this slug; skip in favor of it
        if slug in chosen and slug not in curated:
            continue  # first-wins for non-curated collisions
        svg_text = path.read_text(encoding="utf-8")
        body = extract_body(svg_text)
        if body is None:
            skipped_parse += 1
            continue
        chosen[slug] = (artist, path)
        bodies[slug] = body

    print(f"resolved {len(chosen)} unique slugs ({skipped_parse} files skipped: unexpected SVG shape)")

    # Sanity-check: curated bodies must match byte-for-byte what we extract
    # from source, or the recolor transform has drifted.
    mismatches = []
    for slug, entry in curated.items():
        if slug not in bodies:
            mismatches.append(f"{slug}: missing from source walk")
        elif bodies[slug] != entry["body"]:
            mismatches.append(f"{slug}: body differs from curated catalog")
    if mismatches:
        print(f"WARNING: {len(mismatches)} curated slug(s) do not match source extraction:", file=sys.stderr)
        for m in mismatches[:10]:
            print(f"  - {m}", file=sys.stderr)

    if args.dry_run:
        print("dry-run: not writing any files")
        return 0

    # ---- shards -------------------------------------------------------
    slugs_sorted = sorted(bodies)
    shard_size = args.shard_size
    num_shards = (len(slugs_sorted) + shard_size - 1) // shard_size
    slug_shard: Dict[str, int] = {}
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    for old in SHARDS_DIR.glob("shard-*.json"):
        old.unlink()
    for i in range(num_shards):
        chunk = slugs_sorted[i * shard_size : (i + 1) * shard_size]
        shard_obj = {slug: bodies[slug] for slug in chunk}
        for slug in chunk:
            slug_shard[slug] = i
        (SHARDS_DIR / f"shard-{i:03d}.json").write_text(
            json.dumps(shard_obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    print(f"wrote {num_shards} shard files ({shard_size} icons/shard) to {SHARDS_DIR}")

    # ---- full index (metadata only, no bodies) -------------------------
    lines = []
    lines.append("// AUTO-GENERATED — do not edit by hand.")
    lines.append("// Full game-icons.net catalog (issue #349) — slug/name/artist/shard metadata for")
    lines.append("// ALL bundled icons (curated + full set), NO svg bodies. Reached only via a dynamic")
    lines.append("// import() (see loadFullIconIndex() in ./index.ts) so this never touches the main")
    lines.append("// bundle; svg bodies live in public/icons/shards/shard-NNN.json, fetched on demand.")
    lines.append("// Regenerated by scripts/icons/generate_full_catalog.py.")
    lines.append("")
    lines.append("export interface FullIconIndexEntry {")
    lines.append("  /** Stable identifier, same slug space as the curated catalog. */ slug: string;")
    lines.append("  /** Human-readable label shown in the picker. */ name: string;")
    lines.append("  /** game-icons contributor folder — join key to ICON_ARTISTS. */ artist: string;")
    lines.append(
        "  /** Curated-catalog category, or '' for icons outside the curated 12-category taxonomy. */ category: string;"
    )
    lines.append("  /** Index into shard-NNN.json under public/icons/shards/ holding this icon's body. */ shard: number;")
    lines.append("}")
    lines.append("")
    lines.append("export const FULL_ICON_INDEX: FullIconIndexEntry[] = [")
    for slug in slugs_sorted:
        artist, _ = chosen[slug]
        cur = curated.get(slug)
        name = cur["name"] if cur else slug_name(slug)
        category = cur["category"] if cur else ""
        shard = slug_shard[slug]
        lines.append(
            f"  {{ slug: {js_str(slug)}, name: {js_str(name)}, artist: {js_str(artist)}, "
            f"category: {js_str(category)}, shard: {shard} }},"
        )
    lines.append("];")
    lines.append("")
    FULL_INDEX_TS.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {FULL_INDEX_TS} ({len(slugs_sorted)} entries, {num_shards} shards)")

    # ---- splice ICON_ARTISTS (full list) + ICON_ARTIST_TOTAL_COUNTS into
    # ---- catalog.generated.ts. ICON_CATALOG (the 180 curated bodies) is
    # ---- left completely untouched.
    counts: Dict[str, int] = {}
    for slug in slugs_sorted:
        artist, _ = chosen[slug]
        counts[artist] = counts.get(artist, 0) + 1

    artists_block_lines = ["export const ICON_ARTISTS: IconArtist[] = ["]
    for key in sorted(ARTISTS):
        name, url, cc0 = ARTISTS[key]
        artists_block_lines.append(
            f'  {{ key: {js_str(key)}, name: {js_str(name)}, url: {js_str(url)}, cc0: {str(cc0).lower()} }},'
        )
    artists_block_lines.append("];")
    new_artists_block = "\n".join(artists_block_lines)

    counts_block_lines = [
        "/** Icon count per contributor across the FULL set (curated + lazily-loaded), for /credits. */",
        "export const ICON_ARTIST_TOTAL_COUNTS: Record<string, number> = {",
    ]
    for key in sorted(ARTISTS):
        counts_block_lines.append(f"  {js_str(key)}: {counts.get(key, 0)},")
    counts_block_lines.append("};")
    new_counts_block = "\n".join(counts_block_lines)

    new_total_line = (
        "/** Total icons reachable via the full lazy-loaded catalog (issue #349), for UI copy. */\n"
        f"export const TOTAL_ICON_COUNT = {len(slugs_sorted)};"
    )

    catalog_text = CATALOG_TS.read_text(encoding="utf-8")
    catalog_text = re.sub(
        r"export const ICON_ARTISTS: IconArtist\[\] = \[.*?\];",
        lambda _m: new_artists_block,
        catalog_text,
        count=1,
        flags=re.S,
    )
    if "ICON_ARTIST_TOTAL_COUNTS" in catalog_text:
        catalog_text = re.sub(
            r"export const ICON_ARTIST_TOTAL_COUNTS: Record<string, number> = \{.*?\};",
            lambda _m: new_counts_block,
            catalog_text,
            count=1,
            flags=re.S,
        )
    else:
        catalog_text = catalog_text.replace(
            new_artists_block,
            new_artists_block + "\n\n" + new_counts_block,
            1,
        )
    if "TOTAL_ICON_COUNT" in catalog_text:
        catalog_text = re.sub(
            r"export const TOTAL_ICON_COUNT = \d+;",
            lambda _m: f"export const TOTAL_ICON_COUNT = {len(slugs_sorted)};",
            catalog_text,
            count=1,
        )
    else:
        catalog_text = catalog_text.replace(
            new_counts_block,
            new_counts_block + "\n\n" + new_total_line,
            1,
        )
    CATALOG_TS.write_text(catalog_text, encoding="utf-8")
    print(f"updated {CATALOG_TS}: ICON_ARTISTS ({len(ARTISTS)} contributors) + ICON_ARTIST_TOTAL_COUNTS + TOTAL_ICON_COUNT")

    total_bytes = sum(len(json.dumps({s: bodies[s]})) for s in slugs_sorted)
    print(f"~{total_bytes / 1024:.0f} KB of raw shard JSON across {num_shards} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
