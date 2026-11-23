import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Leaderboard } from "~/app/portal/_components/leaderboard";
import { firstParam } from "~/app/portal/_lib/paths";
import { requireSession } from "~/app/portal/_lib/session";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/server";
import { schoolYear, semester, semesterLabel } from "@buzz/api";
import PortalLoading from "../loading";

export const metadata: Metadata = { title: "Leaderboard" };

const periods = ["semester", "year", "all"] as const;
type Period = (typeof periods)[number];

function periodOf(value: string | undefined): Period {
  return periods.find((period) => period === value) ?? "semester";
}

export default function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string | string[] }>;
}) {
  return (
    <Suspense fallback={<PortalLoading />}>
      <LeaderboardBody searchParams={searchParams} />
    </Suspense>
  );
}

async function LeaderboardBody({
  searchParams,
}: {
  searchParams: Promise<{ period?: string | string[] }>;
}) {
  const period = periodOf(firstParam((await searchParams).period));
  await requireSession(
    period === "semester"
      ? "/portal/leaderboard"
      : `/portal/leaderboard?period=${period}`,
  );

  const board = await api.member
    .leaderboard({ period, limit: 25 })
    .catch((error) => {
      console.error("Leaderboard failed:", error);
      return null;
    });

  const now = new Date();
  const tabs: { period: Period; label: string; note: string }[] = [
    {
      period: "semester",
      label: "This semester",
      note: semesterLabel(semester(now)),
    },
    { period: "year", label: "This school year", note: schoolYear(now) },
    { period: "all", label: "All time", note: "Since the chapter began" },
  ];
  const current = tabs.find((tab) => tab.period === period)!;

  return (
    <div className="max-w-content mx-auto px-5 pt-5 pb-10 sm:px-6 sm:py-14">
      <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
        {current.note}
      </p>
      <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
        Leaderboard
      </h1>
      <nav aria-label="Leaderboard period" className="mt-6">
        <ul className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <li key={tab.period}>
              <Link
                href={
                  tab.period === "semester"
                    ? "/portal/leaderboard"
                    : `/portal/leaderboard?period=${tab.period}`
                }
                aria-current={tab.period === period ? "page" : undefined}
                className={cn(
                  "border-hairline inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-semibold",
                  tab.period === period
                    ? "bg-navy border-navy text-white"
                    : "text-navy hover:bg-cream",
                )}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Leaderboard
        data={board}
        heading={false}
        emptyMessage="Nobody has checked in during this period yet."
        footer={
          <p className="text-ink-muted text-body-sm mt-6">
            Members can hide their name in{" "}
            <Link
              href="/portal/settings"
              className="text-navy inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
            >
              settings
            </Link>
            . They keep their place on the board.
          </p>
        }
      />
    </div>
  );
}
