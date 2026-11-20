// Bun has no built-in way to set an env var for one test and put it back.

const envBefore = new Map<string, string | undefined>();

/**
 * Sets an environment variable, or removes it when the value is undefined.
 * test/support/setup.ts, preloaded for every run, puts it back after each test.
 */
export function stubEnv(name: string, value: string | undefined): void {
  if (!envBefore.has(name)) {
    envBefore.set(name, process.env[name]);
  }
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** Puts the environment variables back as they were before the first stub. */
export function restoreEnv(): void {
  for (const [name, value] of envBefore) {
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  envBefore.clear();
}

/** A function that answers like fetch, without the extras on Bun's fetch type. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Types a stand-in as fetch, for code that takes `typeof fetch` and for
 * `spyOn(globalThis, "fetch").mockImplementation`. Bun's fetch also has a
 * preconnect method, which nothing here calls.
 */
export function asFetch(fn: FetchLike): typeof fetch {
  return Object.assign(fn, { preconnect: () => undefined });
}
