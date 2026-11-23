import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What every share card draws from: the palette, the mascot and the Archivo
 * faces. Satori renders them, and it cannot read woff2 or CSS variables.
 */
export const ogColors = {
  navy: "#003057",
  gold: "#EAAA00",
  ink: "#0F1F30",
  muted: "#4A5866",
  desk: "#EEF1F4",
} as const;

/** Archivo as TTF (Satori cannot read woff2). Null falls back to the default face. */
async function archivo(axes: string) {
  try {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=Archivo:${axes}`,
    ).then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    });
    const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    return url
      ? await fetch(url).then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.arrayBuffer();
        })
      : null;
  } catch {
    return null;
  }
}

export async function ogFonts() {
  const [heavy, regular] = await Promise.all([
    archivo("wdth,wght@125,800"),
    archivo("wght@400"),
  ]);
  return [
    heavy && { name: "Archivo", data: heavy, weight: 800 as const },
    regular && { name: "Archivo", data: regular, weight: 400 as const },
  ].filter((font) => !!font);
}

/** The mascot as a data URL, the one image form Satori accepts without a fetch. */
export async function ogDino() {
  return `data:image/png;base64,${(
    await readFile(join(process.cwd(), "public/brand/sase-dino.png"))
  ).toString("base64")}`;
}
