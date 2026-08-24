import "./load-root-env";
import "./src/env";
import "./src/server/auth-env";

import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const config: NextConfig = {
  transpilePackages: ["@buzz/api", "@buzz/auth", "@buzz/db"],
  poweredByHeader: false,
  async headers() {
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Permissions-Policy",
        value: "camera=(self), microphone=(), geolocation=()",
      },
    ];

    if (isProd) {
      base.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
    }

    return [
      {
        source: "/:path*",
        headers: [
          ...base,
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              isProd
                ? "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com"
                : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default config;
