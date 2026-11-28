import "./load-root-env";
import "./src/env";
import "./src/server/auth-env";

import type { NextConfig } from "next";

import { appBuild } from "./build-version";
import { contentSecurityPolicy } from "./csp";

const isProd = process.env.NODE_ENV === "production";
const build = appBuild();

const config: NextConfig = {
  transpilePackages: [
    "@buzz/api",
    "@buzz/auth",
    "@buzz/db",
    "@buzz/discord-bot",
  ],
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: build.version,
    NEXT_PUBLIC_APP_COMMIT: build.commit,
  },
  agentRules: false,
  images: {
    // Every photo in public/photos is at most 1920px wide, so the default
    // 2048 and 3840 steps return the same bytes under a different cache key.
    // A retina visitor to a 72rem slot asked for w=3840 and paid a cold
    // resize that nobody else had warmed.
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
  },
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
        // Names carry a content hash, so a changed font gets a new URL.
        source: "/fonts/:file([^/]+\\.woff2)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          ...base,
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(isProd),
          },
        ],
      },
    ];
  },
};

export default config;
