import "server-only";

import { unstable_cache } from "next/cache";

import { boardFromResults } from "@buzz/api";
import { db } from "@buzz/db";
import { board as handWritten, type BoardMember } from "~/data/content";

export const BOARD_TAG = "board";

// Throws on a database error: unstable_cache does not store a throw, so one
// transient failure is not served for the whole revalidate window.
async function fetchBoard(): Promise<BoardMember[] | null> {
  if (!process.env.DATABASE_URL) return null;
  return boardFromResults(db);
}

const loadBoard = unstable_cache(fetchBoard, [BOARD_TAG, "v1"], {
  tags: [BOARD_TAG],
  revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
});

/**
 * Who the board page lists: the latest published election's winners, or the
 * hand-written list when no election has been published. A preview runs this
 * code against the production database before migration 0017, where the
 * election tables have a different shape: any database error shows the
 * hand-written list instead of failing the page.
 */
export async function getBoard(): Promise<BoardMember[]> {
  try {
    return (await loadBoard()) ?? handWritten;
  } catch {
    return handWritten;
  }
}
