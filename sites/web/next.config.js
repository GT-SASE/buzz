/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  // The workspace packages ship raw TypeScript rather than a build step, so
  // Next has to compile them the same way it compiles this app's own source.
  transpilePackages: ["@buzz/api", "@buzz/auth", "@buzz/db"],
};

export default config;
