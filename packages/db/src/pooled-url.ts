/**
 * Neon pooled endpoints are `ep-…-pooler.…neon.tech`. Direct endpoints pay a
 * TCP setup on every cold function, which is the p99. Local Postgres is left
 * alone. Migrations keep using DATABASE_URL as written — this rewrite is only
 * for the request-path client.
 */
export function pooledConnectionString(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!parsed.hostname.endsWith(".neon.tech")) return url;
  if (parsed.hostname.includes("-pooler")) return url;

  parsed.hostname = parsed.hostname.replace(/^([^.]+)/, "$1-pooler");
  return parsed.toString();
}
