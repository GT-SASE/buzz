// Bun 1.4.4 has no vi.stubEnv/vi.stubGlobal, no bunfig unstubEnvs/restoreMocks and no
// expect.soft, so these small helpers fill the gap until Bun ships them.

/**
 * Stand-ins for settings and globals that a test swaps out. test/support/setup.ts,
 * preloaded for every run, undoes them after each test.
 */

const envBefore = new Map<string, string | undefined>();
const globalsBefore = new Map<PropertyKey, PropertyDescriptor | undefined>();

/** Sets an environment variable, or removes it when the value is undefined. */
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

/** Replaces a global, such as fetch. */
export function stubGlobal(name: PropertyKey, value: unknown): void {
  if (!globalsBefore.has(name)) {
    globalsBefore.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/** Puts the globals back as they were before the first stub. */
export function restoreGlobals(): void {
  for (const [name, descriptor] of globalsBefore) {
    if (descriptor === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as Record<PropertyKey, unknown>)[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
  globalsBefore.clear();
}

/** A function that answers like fetch, without the extras on Bun's fetch type. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Types a stand-in as fetch, for code that takes `typeof fetch`. Bun's fetch also has
 * a preconnect method, which nothing here calls.
 */
export function asFetch(fn: FetchLike): typeof fetch {
  return Object.assign(fn, { preconnect: () => undefined });
}
