// Relative import: this file is also loaded from `next.config.ts`, where the
// `~/*` path alias is not available during config transpile.
import { site } from "../data/site";

process.env.AUTH_REDIRECT_PROXY_URL ??= `${site.url}/api/auth`;
