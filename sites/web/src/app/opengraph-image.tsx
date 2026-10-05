import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { site } from "~/data/site";

export const alt = `${site.name} — ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const navy = "#003057";
const gold = "#EAAA00";
const ink = "#0F1F30";
const muted = "#4A5866";
const desk = "#EEF1F4";

/** Archivo as TTF (Satori cannot read woff2). Falls back to the default face. */
async function archivo(axes: string) {
  try {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=Archivo:${axes}`,
    ).then((res) => res.text());
    const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    return url ? await fetch(url).then((res) => res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/**
 * The share card for every page (Next applies the nearest ancestor image).
 * Rendered by Satori, which supports a flexbox subset of CSS only — every
 * element with more than one child needs an explicit `display: flex`, and
 * `gap`, `grid`, and shorthand `background` with layers are unavailable.
 */
export default async function OpengraphImage() {
  const emblem = `data:image/png;base64,${(
    await readFile(join(process.cwd(), "public/brand/sase-emblem.png"))
  ).toString("base64")}`;
  const [heavy, regular] = await Promise.all([
    archivo("wdth,wght@125,800"),
    archivo("wght@400"),
  ]);
  const fonts = [
    heavy && { name: "Archivo", data: heavy, weight: 800 as const },
    regular && { name: "Archivo", data: regular, weight: 400 as const },
  ].filter((font) => !!font);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        backgroundColor: desk,
        fontFamily: "Archivo",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 0 72px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders plain <img> only */}
          <img src={emblem} width={64} height={64} alt="" />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginLeft: 18,
            }}
          >
            <div style={{ fontSize: 30, fontWeight: 800, color: navy }}>
              SASE
            </div>
            <div style={{ fontSize: 20, color: muted }}>Georgia Tech</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 800,
              color: navy,
              lineHeight: 1.02,
              letterSpacing: -2,
            }}
          >
            Find your people
          </div>
          <div
            style={{
              fontSize: 84,
              fontWeight: 800,
              color: navy,
              lineHeight: 1.02,
              letterSpacing: -2,
            }}
          >
            in STEM.
          </div>
          <div style={{ fontSize: 28, color: muted, marginTop: 26 }}>
            Free to join. Any major, any year.
          </div>
        </div>
      </div>

      <div
        style={{
          width: 400,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", width: 72, height: 150 }}>
          <div style={{ flex: 1, backgroundColor: navy }} />
          <div style={{ width: 16, backgroundColor: gold }} />
          <div style={{ flex: 1, backgroundColor: navy }} />
        </div>
        <div
          style={{
            width: 300,
            marginTop: -6,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#ffffff",
            borderRadius: 26,
            overflow: "hidden",
            boxShadow: "0 18px 40px rgba(15,31,48,0.18)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              backgroundColor: navy,
              padding: "22px 0 18px",
            }}
          >
            <div
              style={{
                width: 54,
                height: 10,
                borderRadius: 999,
                backgroundColor: desk,
              }}
            />
            <div
              style={{
                fontSize: 40,
                fontWeight: 800,
                color: "#ffffff",
                marginTop: 16,
              }}
            >
              HELLO
            </div>
            <div style={{ fontSize: 20, color: gold }}>my name is</div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "34px 20px 30px",
            }}
          >
            <div
              style={{
                fontSize: 27,
                fontWeight: 800,
                color: ink,
                lineHeight: 1.1,
                textAlign: "center",
              }}
            >
              The newest SASE member.
            </div>
            <div
              style={{
                width: 200,
                height: 2,
                backgroundColor: "rgba(15,31,48,0.13)",
                marginTop: 18,
              }}
            />
            <div style={{ fontSize: 18, color: muted, marginTop: 14 }}>
              SASE at Georgia Tech
            </div>
          </div>
        </div>
      </div>
    </div>,
    { ...size, fonts },
  );
}
