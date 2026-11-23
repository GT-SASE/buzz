import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

const navy = "#003057";
const gold = "#EAAA00";
const ink = "#0F1F30";
const muted = "#4A5866";
const desk = "#EEF1F4";

const size = { width: 1200, height: 630 };

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

async function loadAssets() {
  const dino = `data:image/png;base64,${(
    await readFile(join(process.cwd(), "public/brand/sase-dino.png"))
  ).toString("base64")}`;
  const [heavy, regular] = await Promise.all([
    archivo("wdth,wght@125,800"),
    archivo("wght@400"),
  ]);
  const fonts = [
    heavy && { name: "Archivo", data: heavy, weight: 800 as const },
    regular && { name: "Archivo", data: regular, weight: 400 as const },
  ].filter((font) => !!font);
  return { dino, fonts };
}

// One fetch of the fonts per worker, not one per page. A failed fetch is not
// kept, so a later render tries again.
let assets: ReturnType<typeof loadAssets> | undefined;
async function getAssets() {
  assets ??= loadAssets();
  const loaded = await assets;
  if (loaded.fonts.length < 2) assets = undefined;
  return loaded;
}

/** The badge is 260px of type wide, and the uppercase face runs about 0.95em a letter. */
function labelSize(label: string) {
  return Math.max(24, Math.min(44, Math.floor(250 / (label.length * 0.95))));
}

/** Long titles step down so two or three lines still fit the left column. */
function titleSize(title: string) {
  if (title.length <= 12) return 84;
  if (title.length <= 20) return 64;
  if (title.length <= 34) return 60;
  return 52;
}

/**
 * A page's share card, in the same lanyard-and-badge style as the chapter's
 * (`app/opengraph-image.tsx`): the headline and a line under it on the left,
 * the page's name on the badge. Rendered by Satori, which supports a flexbox
 * subset of CSS only: every element with more than one child needs an explicit
 * `display: flex`, and `gap` and `grid` are unavailable.
 *
 * `label` is the badge's heading (a word or two), `title` the headline, and
 * `subtitle` one line of the page's own copy.
 */
export async function renderShareCard({
  label,
  title,
  subtitle,
}: {
  label: string;
  title: string;
  subtitle: string;
}) {
  const { dino, fonts } = await getAssets();

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
          <img src={dino} width={67} height={80} alt="" />
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
              display: "flex",
              fontSize: titleSize(title),
              fontWeight: 800,
              color: navy,
              lineHeight: 1.04,
              letterSpacing: -2,
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              color: muted,
              marginTop: 26,
              lineHeight: 1.3,
              paddingRight: 40,
            }}
          >
            {subtitle}
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
              padding: "22px 20px 22px",
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
                display: "flex",
                fontSize: labelSize(label),
                fontWeight: 800,
                color: "#ffffff",
                marginTop: 16,
                textTransform: "uppercase",
                textAlign: "center",
              }}
            >
              {label}
            </div>
            <div style={{ display: "flex", fontSize: 20, color: gold }}>
              SASE GT
            </div>
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
                display: "flex",
                fontSize: 27,
                fontWeight: 800,
                color: ink,
                lineHeight: 1.1,
                textAlign: "center",
              }}
            >
              Free to join.
            </div>
            <div
              style={{
                width: 200,
                height: 2,
                backgroundColor: "rgba(15,31,48,0.13)",
                marginTop: 18,
              }}
            />
            <div
              style={{
                display: "flex",
                fontSize: 18,
                color: muted,
                marginTop: 14,
              }}
            >
              SASE at Georgia Tech
            </div>
          </div>
        </div>
      </div>
    </div>,
    { ...size, fonts },
  );
}

/** Cuts text to `length` characters, ending in an ellipsis, so it fits the card. */
export function clipCardText(text: string, length: number) {
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}
