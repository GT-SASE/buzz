#!/usr/bin/env python3
"""Subset the site's web fonts. Run by hand and commit the output.

Reads scripts/fonts/source/ and writes:
  sites/web/public/fonts/*.woff2         hashed font files
  sites/web/src/styles/fonts.generated.css
  sites/web/src/data/fonts.generated.ts  files to preload

Nothing here runs during `next build`. See scripts/fonts/README.md for when to
rerun it.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = HERE / "source"
SITE_SOURCE = ROOT / "sites/web/src"
PUBLIC = ROOT / "sites/web/public/fonts"
CSS = ROOT / "sites/web/src/styles/fonts.generated.css"
PRELOADS = ROOT / "sites/web/src/data/fonts.generated.ts"

SCANNED_SUFFIXES = {".ts", ".tsx", ".css", ".json", ".mdx"}


def codes(*spans: tuple[int, int] | int) -> set[int]:
    result: set[int] = set()
    for span in spans:
        if isinstance(span, int):
            result.add(span)
        else:
            result.update(range(span[0], span[1] + 1))
    return result


ASCII = codes((0x20, 0x7E))
# Curly quotes, dashes, ellipsis, plus the no-break space and the middle dot
# that the page titles and event rows use.
CORE_PUNCTUATION = codes(0xA0, 0xB7, 0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026)
LATIN_1 = codes((0xA0, 0xFF))
LATIN_EXT_A = codes((0x100, 0x17F))
# Member names come from Google accounts, and Vietnamese names render in these
# fonts today. Dropping them would redraw those names in a system font.
VIETNAMESE = codes(
    (0x102, 0x103), (0x110, 0x111), (0x128, 0x129), (0x168, 0x169), (0x1A0, 0x1A1),
    (0x1AF, 0x1B0), (0x300, 0x301), (0x303, 0x304), (0x308, 0x309), 0x323, 0x329,
    (0x1EA0, 0x1EF9), 0x20AB,
)

# The union of what next/font served before this script existed. A character
# outside it was drawn by a system font even when the font file contains it, so
# adding it here would change how the site looks.
GOOGLE_LATIN = codes(
    (0x0, 0xFF), 0x131, (0x152, 0x153), (0x2BB, 0x2BC), 0x2C6, 0x2DA, 0x2DC, 0x304, 0x308,
    0x329, (0x2000, 0x206F), 0x20AC, 0x2122, 0x2191, 0x2193, 0x2212, 0x2215, 0xFEFF, 0xFFFD,
)
GOOGLE_LATIN_EXT = codes(
    (0x100, 0x2BA), (0x2BD, 0x2C5), (0x2C7, 0x2CC), (0x2CE, 0x2D7), (0x2DD, 0x2FF), 0x304,
    0x308, 0x329, (0x1D00, 0x1DBF), (0x1E00, 0x1E9F), (0x1EF2, 0x1EFF), 0x2020,
    (0x20A0, 0x20AB), (0x20AD, 0x20C4), 0x2113, (0x2C60, 0x2C7F), (0xA720, 0xA7FF),
)
GOOGLE_CYRILLIC = codes(0x301, (0x400, 0x45F), (0x490, 0x491), (0x4B0, 0x4B1), 0x2116)
GOOGLE_CYRILLIC_EXT = codes(
    (0x460, 0x52F), (0x1C80, 0x1C8A), 0x20B4, (0x2DE0, 0x2DFF), (0xA640, 0xA69F),
    (0xFE2E, 0xFE2F),
)
GOOGLE_COVERAGE = GOOGLE_LATIN | GOOGLE_LATIN_EXT | VIETNAMESE

# Default-on shaping the site relies on, plus `tabular-nums` (tnum). rvrn swaps
# glyphs along the axes. Everything else is unused: no fractions, no `lang`
# other than English (locl), no `proportional-nums` (pnum).
ARCHIVO_FEATURES = ["ccmp", "kern", "liga", "mark", "mkmk", "rvrn", "tnum"]
MONO_FEATURES = ["ccmp", "mark"]


@dataclass
class Face:
    slug: str
    css_family: str
    source: str
    license_file: str
    css_weight: str
    features: list[str]
    coverage: set[int]
    preload: bool = True
    css_stretch: str | None = None
    axis_limits: dict[str, tuple[float, float]] = field(default_factory=dict)
    # (old, new) replacements for the font's internal names.
    rename: list[tuple[str, str]] = field(default_factory=list)


FACES = [
    Face(
        slug="archivo",
        css_family="Archivo",
        source="Archivo[wdth,wght].ttf",
        license_file="OFL-Archivo.txt",
        css_weight="100 900",
        css_stretch="100% 125%",
        features=ARCHIVO_FEATURES,
        coverage=GOOGLE_COVERAGE,
        # .font-display is 125%, buttons 112%, body 100%. wght stays whole even
        # though nothing is lighter than 400. Its default is 600, so a limit
        # rescales every delta below that and moves advances by a unit, which
        # rewraps body text to save about 1 KB.
        axis_limits={"wdth": (100, 125)},
    ),
    Face(
        slug="sase-mono",
        # "Plex" is a Reserved Font Name, so a subset cannot carry it.
        css_family="SASE Mono",
        source="IBMPlexMono-Medium.ttf",
        license_file="OFL-IBMPlexMono.txt",
        css_weight="500",
        features=MONO_FEATURES,
        coverage=GOOGLE_COVERAGE | GOOGLE_CYRILLIC | GOOGLE_CYRILLIC_EXT,
        rename=[("IBM Plex Mono", "SASE Mono"), ("IBMPlexMono", "SASEMono")],
    ),
]

# Copied verbatim from what next/font generated. Do not recompute.
FALLBACKS = """\
@font-face {
  font-family: "Archivo Fallback";
  src: local(Arial);
  ascent-override: 88.96%;
  descent-override: 21.28%;
  line-gap-override: 0%;
  size-adjust: 98.7%;
}
@font-face {
  font-family: "IBM Plex Mono Fallback";
  src: local(Arial);
  ascent-override: 76.16%;
  descent-override: 20.43%;
  line-gap-override: 0%;
  size-adjust: 134.59%;
}
:root {
  --font-archivo: "Archivo", "Archivo Fallback";
  --font-ibm: "SASE Mono", "IBM Plex Mono Fallback";
}
"""


# Font-wide extents stay those of the whole font, as Google's subsets kept them.
EXTENTS = {
    "head": ["xMin", "yMin", "xMax", "yMax"],
    "hhea": ["advanceWidthMax", "minLeftSideBearing", "minRightSideBearing", "xMaxExtent"],
}


def site_characters() -> set[int]:
    """Every non-ASCII character written in the site's source."""
    found: set[int] = set()
    for path in SITE_SOURCE.rglob("*"):
        if path.suffix not in SCANNED_SUFFIXES or ".generated." in path.name:
            continue
        found.update(ord(char) for char in path.read_text(encoding="utf-8") if ord(char) > 0x7E)
    return found


def limit_axes(face: Face) -> bytes:
    # By default a saved font is stamped with the current time, which gives every
    # run new bytes and new file names. It also has its bounding box recomputed,
    # and browsers size a default <input> from that box.
    font = TTFont(SOURCE / face.source, recalcTimestamp=False, recalcBBoxes=False)
    if face.axis_limits:
        font = instancer.instantiateVariableFont(font, face.axis_limits)
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def cut(face: Face, data: bytes, wanted: set[int]) -> TTFont:
    options = subset.Options()
    options.layout_features = face.features
    options.layout_scripts = ["*"]
    options.hinting = False
    options.glyph_names = False
    options.notdef_outline = False
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    options.name_languages = [0x409]
    options.drop_tables += ["STAT", "DSIG", "meta"]
    options.recalc_timestamp = False

    font = TTFont(io.BytesIO(data), recalcTimestamp=False, recalcBBoxes=False)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    for record in font["name"].names:
        text = record.toUnicode()
        for old, new in face.rename:
            text = text.replace(old, new)
        record.string = text
    font.flavor = "woff2"
    return font


def to_bytes(font: TTFont) -> bytes:
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def ranges(values: set[int]) -> str:
    """CSS unicode-range for exactly these code points."""
    spans: list[list[int]] = []
    for value in sorted(values):
        if spans and value == spans[-1][1] + 1:
            spans[-1][1] = value
        else:
            spans.append([value, value])
    return ", ".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in spans)


def verify(face: Face, data: bytes, expected: set[int]) -> None:
    """Font tools fail quietly, so reload what was written and check it."""
    font = TTFont(io.BytesIO(data))
    assert font.flavor == "woff2", f"{face.slug}: not woff2"
    cmap = set(font.getBestCmap())
    assert cmap == expected, (
        f"{face.slug}: cmap differs from the unicode-range by "
        f"{ranges(cmap ^ expected)}"
    )
    source = TTFont(SOURCE / face.source, lazy=True)
    for table, fields in EXTENTS.items():
        for name in fields:
            kept, original = getattr(font[table], name), getattr(source[table], name)
            assert kept == original, f"{face.slug}: {table}.{name} is {kept}, not {original}"
    for table in ("fpgm", "prep", "cvt ", "cvar", "hdmx", "VDMX", "LTSH", "STAT"):
        assert table not in font, f"{face.slug}: {table} survived"
    if "glyf" in font:
        glyf = font["glyf"]
        for name in glyf.keys():
            program = getattr(glyf[name], "program", None)
            assert program is None or not program.getBytecode(), f"{face.slug}: {name} is hinted"
    if face.axis_limits:
        axes = {axis.axisTag: (axis.minValue, axis.maxValue) for axis in font["fvar"].axes}
        for tag, span in face.axis_limits.items():
            assert axes[tag] == tuple(map(float, span)), f"{face.slug}: {tag} is {axes[tag]}"
    active = set()
    for table in ("GSUB", "GPOS"):
        if table in font and font[table].table.FeatureList:
            active.update(r.FeatureTag for r in font[table].table.FeatureList.FeatureRecord)
    assert active <= set(face.features), f"{face.slug}: kept {sorted(active - set(face.features))}"
    license_text = (SOURCE / face.license_file).read_text(encoding="utf-8")
    for reserved in re.findall(r'Reserved Font Name "([^"]+)"', license_text):
        for record in font["name"].names:
            assert reserved not in record.toUnicode(), f"{face.slug}: name still has {reserved}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--small-core",
        action="store_true",
        help="ASCII and punctuation only in core. Saves bytes, loses kerning next to accents.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print sizes and write nothing.")
    args = parser.parse_args()

    used = site_characters()
    written: list[tuple[str, bytes]] = []
    css: list[str] = ["/* Generated by scripts/fonts/subset.py. Do not edit. */\n"]
    preloads: list[str] = []

    for face in FACES:
        data = limit_axes(face)
        available = set(TTFont(io.BytesIO(data)).getBestCmap()) & face.coverage
        # A character the site writes belongs in core when it shared a file with
        # ASCII before: it kerns against ASCII, and in extended two sort arrows
        # would pull that whole file onto the page.
        core_wanted = ASCII | CORE_PUNCTUATION | (used & GOOGLE_LATIN)
        if not args.small_core:
            core_wanted |= LATIN_1
        core = core_wanted & available
        extended = ((LATIN_1 | LATIN_EXT_A | VIETNAMESE | used) & available) - core

        for part, wanted, preload in (("core", core, face.preload), ("extended", extended, False)):
            payload = to_bytes(cut(face, data, wanted))
            verify(face, payload, wanted)
            digest = hashlib.sha256(payload).hexdigest()[:10]
            name = f"{face.slug}-{part}.{digest}.woff2"
            written.append((name, payload))
            print(f"{name:42} {len(payload):>7} bytes  {len(wanted):>4} characters")
            descriptors = [
                f'  font-family: "{face.css_family}";',
                "  font-style: normal;",
                f"  font-weight: {face.css_weight};",
            ]
            if face.css_stretch:
                descriptors.append(f"  font-stretch: {face.css_stretch};")
            descriptors += [
                "  font-display: swap;",
                f'  src: url("/fonts/{name}") format("woff2");',
                f"  unicode-range: {ranges(wanted)};",
            ]
            css.append("@font-face {\n" + "\n".join(descriptors) + "\n}\n")
            if preload:
                preloads.append(f"/fonts/{name}")

    if args.dry_run:
        return

    PUBLIC.mkdir(parents=True, exist_ok=True)
    for stale in PUBLIC.glob("*.woff2"):
        stale.unlink()
    for name, payload in written:
        (PUBLIC / name).write_bytes(payload)
    for face in FACES:
        target = PUBLIC / face.license_file
        target.write_bytes((SOURCE / face.license_file).read_bytes())
    CSS.write_text("".join(css) + FALLBACKS, encoding="utf-8", newline="\n")
    listed = "".join(f'  "{path}",\n' for path in preloads)
    PRELOADS.write_text(
        "// Generated by scripts/fonts/subset.py. Do not edit.\n"
        f"export const fontPreloads = [\n{listed}] as const;\n",
        encoding="utf-8",
        newline="\n",
    )


if __name__ == "__main__":
    main()
