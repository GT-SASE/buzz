let next = 3n * 10n ** 17n + BigInt(Math.floor(Math.random() * 1e9)) * 1000n;

/**
 * A placeholder Discord ID. Given a number, it is the same ID each time. Given none, it
 * is a new one. New ones start from a random point, so runs against a long-lived
 * database do not reuse them.
 */
export function fakeId(n?: number): string {
  if (n !== undefined) {
    return (10n ** 17n + BigInt(n)).toString();
  }
  next += 1n;
  return next.toString();
}
