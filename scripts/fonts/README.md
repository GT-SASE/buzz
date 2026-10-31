# Web fonts

`subset.py` cuts the fonts in `source/` down to what the site uses. It runs by
hand and its output is committed. Nothing here runs during `next build`.

```sh
python -m pip install -r scripts/fonts/requirements.txt
python scripts/fonts/subset.py
pnpm exec prettier --write sites/web/src/styles/fonts.generated.css
```

Commit `sites/web/public/fonts/`, `sites/web/src/styles/fonts.generated.css` and
`sites/web/src/data/fonts.generated.ts`. Same input gives the same bytes, so a
clean rerun changes nothing. `--dry-run` prints sizes and writes nothing.

## Rerun when

- Text in `sites/web/src` adds a character the fonts lack. Latin-1, Latin
  Extended-A, Vietnamese and `† • ‹ › € ™` are already covered. The script scans
  the source, but it cannot see text stored in the database.
- The mono font starts appearing on normal pages. It is not preloaded, because
  only the error pages use it. Set `preload=True` on its face if that changes.
- A style needs a width outside 100% to 125%. The browser clamps to that range
  without any error. Every Archivo weight from 100 to 900 ships.
- A style turns on an OpenType feature not listed in `subset.py`, such as
  `proportional-nums`, `ordinal`, or text in a language that needs `locl`.
- A new weight of the mono font is used. Only 500 ships.
- The files in `source/` change.

## Rules that keep rendering the same

- Coverage stays inside what Google served before. A character outside it was
  drawn by a system font even when the font file has it.
- The Archivo weight axis is not limited. Its default is 600, so a limit at 400
  rescales every delta below that and moves advances by 1/1000 em. That rewraps
  body text to save about 1 KB. The width axis has its default at the limit, so
  cutting it moves no advances.
- Core holds all of Latin-1. Kerning cannot cross font files, so moving accented
  letters to the extended file loses kerning against their ASCII neighbours.
  `--small-core` builds that smaller version.
- Core and extended share one family name. Separate families would put the
  generated fallback face between them, and it would draw the extended characters.
- Font-wide extents in `head` and `hhea` stay those of the whole font. Browsers
  size a default `<input>` from them, so recomputing them for the subset narrows
  that input by 8px. The script fails if they drift.
- The fallback faces are copied from what `next/font` generated. Do not recompute
  them.
- "Plex" is a Reserved Font Name under the OFL, so the mono subset is named
  SASE Mono, inside the font and in CSS. The licenses ship in `public/fonts/`.
