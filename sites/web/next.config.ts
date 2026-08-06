import "./src/env";

import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@buzz/api", "@buzz/auth", "@buzz/db"],
};

export default config;
