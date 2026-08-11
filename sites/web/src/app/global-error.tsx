"use client";

import { useEffect } from "react";

/**
 * Root error boundary. Replaces the entire document shell, so html/body must
 * be rendered here — the root layout is not available when this mounts.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Root render failed:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f7f4ef",
          color: "#1a2332",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "28rem", width: "100%", textAlign: "center" }}>
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              margin: "0 0 0.75rem",
            }}
          >
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 1.5rem", opacity: 0.75, lineHeight: 1.5 }}>
            The site could not load. Try again in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: "#c4a35a",
              color: "#003057",
              border: "none",
              padding: "0.65rem 1.25rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p
              style={{
                marginTop: "1.5rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                opacity: 0.55,
              }}
            >
              Reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
