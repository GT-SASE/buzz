"use client";

import { useState } from "react";

import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { api } from "~/trpc/react";
import { KinGroupManager } from "./kin-group-manager";
import { MentorshipRoster } from "./mentorship-roster";

export function KinAdmin({ currentYear }: { currentYear: string }) {
  const [year, setYear] = useState(currentYear);
  const years = api.mentorship.years.useQuery();
  const readOnly = year !== currentYear;

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <Label htmlFor="kin-year">School year</Label>
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger id="kin-year" className="h-auto min-h-11 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(years.data ?? [currentYear]).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {readOnly && (
          <p className="text-ink-muted text-body-sm">Past year — read only.</p>
        )}
      </div>

      <KinGroupManager year={year} readOnly={readOnly} />
      <h2 className="font-display text-navy text-h3 mt-12 mb-5 font-bold tracking-tight">
        Signups
      </h2>
      <MentorshipRoster year={year} readOnly={readOnly} />
    </>
  );
}
