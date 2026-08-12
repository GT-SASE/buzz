import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * The home-screen icon. iOS does not round-trip transparency or apply its own
 * padding, so this paints the full navy square and insets the lockup itself.
 * Members add the portal to their home screen to check in, which is the whole
 * reason this exists.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#003057",
        }}
      >
        <div
          style={{
            display: "flex",
            color: "#eaaa00",
            fontSize: 96,
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          SASE
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 14,
            color: "#ffffff",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 4,
          }}
        >
          GT
        </div>
      </div>
    ),
    size,
  );
}
