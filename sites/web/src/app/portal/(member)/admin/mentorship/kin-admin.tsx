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
import { semesterLabel } from "@buzz/api/terms";
import { api } from "~/trpc/react";
import { KinGroupManager } from "./kin-group-manager";
import { MentorshipRoster } from "./mentorship-roster";

export function KinAdmin({ currentSemester }: { currentSemester: string }) {
  const [term, setTerm] = useState(currentSemester);
  const semesters = api.mentorship.semesters.useQuery();
  const readOnly = term !== currentSemester;

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <Label htmlFor="kin-semester">Semester</Label>
        <Select value={term} onValueChange={setTerm}>
          <SelectTrigger id="kin-semester" className="h-auto min-h-11 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(semesters.data ?? [currentSemester]).map((option) => (
              <SelectItem key={option} value={option}>
                {semesterLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {readOnly && (
          <p className="text-ink-muted text-body-sm">
            Past semester, read only.
          </p>
        )}
      </div>

      <KinGroupManager semester={term} readOnly={readOnly} />
      <h2 className="font-display text-navy text-h3 mt-12 mb-5 font-bold tracking-tight">
        Signups
      </h2>
      <MentorshipRoster semester={term} readOnly={readOnly} />
    </>
  );
}
