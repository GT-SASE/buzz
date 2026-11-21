import "./load-root-env";
import "./src/env";
import "./src/server/auth-env";

import type { NextConfig } from "next";

import { appBuild } from "./build-version";
import { contentSecurityPolicy } from "./csp";

const isProd = process.env.NODE_ENV === "production";
const build = appBuild();

const config: NextConfig = {
  transpilePackages: ["@buzz/api", "@buzz/auth", "@buzz/db"],
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: build.version,
    NEXT_PUBLIC_APP_COMMIT: build.commit,
  },
  agentRules: false,
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
