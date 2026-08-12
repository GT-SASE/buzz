import { vi } from "vitest";

export const push = vi.fn();
export const refresh = vi.fn();

export function useRouter() {
  return {
    push,
    refresh,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  };
}

export function usePathname() {
  return "/portal/check-in";
}

export function useSearchParams() {
  return new URLSearchParams();
}
