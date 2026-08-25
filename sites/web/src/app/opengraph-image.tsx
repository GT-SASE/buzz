import { ImageResponse } from "next/og";

import { site } from "~/data/site";

export const alt = `${site.name} — ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The share card for every page (Next applies the nearest ancestor image).
 * Rendered by Satori, which supports a flexbox subset of CSS only — every
 * element with more than one child needs an explicit `display: flex`, and
 * `gap`, `grid`, and shorthand `background` with layers are unavailable.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        backgroundColor: "#f6f1e3",
        backgroundImage:
          "radial-gradient(900px 600px at 8% -10%, rgba(234,170,0,0.30), rgba(246,241,227,0)), radial-gradient(700px 500px at 100% 100%, rgba(0,48,87,0.16), rgba(246,241,227,0))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 68,
              height: 76,
              backgroundColor: "#003057",
              color: "#eaaa00",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 700,
              clipPath:
                "polygon(50% 5%, 94% 27.5%, 94% 72.5%, 50% 95%, 6% 72.5%, 6% 27.5%)",
            }}
          >
            GT
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginLeft: 22,
            }}
          >
            <div style={{ fontSize: 30, fontWeight: 700, color: "#003057" }}>
              SASE
            </div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 600,
                color: "#5b5348",
                letterSpacing: 3,
                textTransform: "uppercase",
                marginTop: 4,
              }}
            >
              Georgia Tech
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            border: "2px solid rgba(179,163,105,0.55)",
            borderRadius: 999,
            padding: "12px 26px 12px 20px",
            fontSize: 24,
            fontWeight: 700,
            color: "#003057",
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              backgroundColor: "#eaaa00",
              marginRight: 12,
              clipPath:
                "polygon(50% 5%, 94% 27.5%, 94% 72.5%, 50% 95%, 6% 72.5%, 6% 27.5%)",
            }}
          />
          {site.theme}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontSize: 92,
            fontWeight: 700,
            color: "#003057",
            lineHeight: 1.04,
            letterSpacing: -2.5,
          }}
        >
          Find your people
        </div>
        <div
          style={{
            fontSize: 92,
            fontWeight: 700,
            color: "#003057",
            lineHeight: 1.04,
            letterSpacing: -2.5,
          }}
        >
          in STEM.
        </div>
        <div
          style={{
            width: 150,
            height: 7,
            backgroundColor: "#eaaa00",
            borderRadius: 999,
            marginTop: 34,
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 26,
          color: "#5b5348",
        }}
      >
        <div style={{ display: "flex" }}>{site.tagline}</div>
        <div style={{ display: "flex", fontWeight: 600, color: "#003057" }}>
          Any major. Any year.
        </div>
      </div>
    </div>,
    size,
  );
}
