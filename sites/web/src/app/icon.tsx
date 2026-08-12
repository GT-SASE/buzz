import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * The tab icon. Generated rather than shipped as a file so it stays in step
 * with the brand colours used by the share card, and so there is one place to
 * change if the chapter re-brands.
 *
 * At 32px nothing but the monogram survives, so this is the wordmark reduced
 * to "S" on navy — the same lockup the nav uses.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#003057",
          color: "#eaaa00",
          fontSize: 22,
          fontWeight: 700,
        }}
      >
        S
      </div>
    ),
    size,
  );
}
