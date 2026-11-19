const original = new Map<string, string | undefined>();

export function stubEnv(name: string, value: string): void {
  if (!original.has(name)) original.set(name, process.env[name]);
  process.env[name] = value;
}

export function unstubAllEnvs(): void {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  original.clear();
}
