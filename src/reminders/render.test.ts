import { describe, expect, it } from "bun:test";
import { HOSTILE_TEXT } from "../../test/support/hostile-text.ts";
import { safe, safeTextValue, type ChunkLine } from "../discord/safe-text.ts";
import { channelMessage } from "../discord/outbound.ts";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  packBatches,
  renderDue,
  renderEventHeader,
  renderMessages,
  renderReminderLine,
} from "./render.ts";
import { fakeId } from "../../test/support/ids.ts";

function date(value: string): DateOnly {
  const parsed = parseIsoDate(value);
  if (parsed === null) {
    throw new Error("bad test date");
  }
  return parsed;
}

const TODAY = date("2026-11-04");
const USER = fakeId(1);
const TASK = "11111111-1111-4111-8111-111111111111";

function reminder(description: string, assigneeId = USER) {
  return renderReminderLine({
    taskId: TASK,
    assigneeId,
    description,
    dueDate: date("2026-11-05"),
    today: TODAY,
  });
}

function line(description: string, assigneeId = USER): ChunkLine {
  return reminder(description, assigneeId).line;
}

function text(chunkLine: ChunkLine): string {
  return safeTextValue(chunkLine.text);
}

/** Removes every escape, leaving only syntax Discord would still act on. */
function withoutEscaped(value: string): string {
  return value.replace(/\\[\s\S]/g, "");
}

describe("renderDue", () => {
  it.each([
    ["2026-11-07", "due Nov 7, 2026, 3 days left"],
    ["2026-11-04", "due today, Nov 4, 2026"],
    ["2026-11-03", "was due Nov 3, 2026, 1 day ago"],
  ])("says when %s is due", (due, expected) => {
    expect(safeTextValue(renderDue(TODAY, date(due)))).toBe(expected);
  });

  it("counts across a change of clocks by calendar day", () => {
    expect(
      safeTextValue(renderDue(date("2026-03-08"), date("2026-03-09"))),
    ).toContain("1 day left");
    expect(
      safeTextValue(renderDue(date("2026-11-01"), date("2026-11-02"))),
    ).toContain("1 day left");
  });
});

describe("hostile task text", () => {
  it.each([
    "@everyone @here",
    "<@&123456789012345>",
    "[Portal login required](https://evil.example)",
    "line one\n# line two\n> line three",
    "reversed ‮text‬",
  ])("makes %j inert", (description) => {
    const rendered = text(line(description));
    const active = withoutEscaped(rendered).replace(`<@${USER}>`, "");
    expect(active).not.toMatch(/[<>[\]()*_~`|#@\n]/);
    expect(rendered.includes("‮")).toBe(false);
  });

  it("pings only the assignee, whatever the text names", () => {
    const rendered = line(`<@${fakeId(2)}> @everyone`);
    expect(rendered.mentionUserIds).toEqual([USER]);
    const [message] = renderMessages(renderEventHeader("Meeting"), [rendered]);
    if (message === undefined) {
      throw new Error("expected a message");
    }
    expect(channelMessage(message).payload).toMatchObject({
      allowed_mentions: { parse: [], users: [USER] },
      flags: 4,
    });
  });

  it("makes a hostile event name inert", () => {
    const header = renderEventHeader("@everyone [x](https://evil.example)");
    const active = withoutEscaped(text(header));
    expect(active.replaceAll("**", "")).not.toMatch(/[<>[\]()@]/);
    expect(header.mentionUserIds).toEqual([]);
  });
});

describe("text with nothing visible", () => {
  it("still produces a reminder, with a stand-in", () => {
    const rendered = reminder("​​");
    expect(rendered.usedStandIn).toBe(true);
    expect(text(rendered.line)).toContain("no readable description");
    expect(text(rendered.line)).toContain("Nov 5, 2026");
  });

  it("uses a plain header for an unreadable event name", () => {
    expect(text(renderEventHeader("​"))).toBe("**Task reminders**");
  });
});

describe("packBatches", () => {
  const header = renderEventHeader("Meeting");
  const asLine = (value: ChunkLine) => value;

  it("puts short items in one message under the header", () => {
    const lines = [line("One"), line("Two")];
    const [batch, ...rest] = packBatches(header, lines, asLine);
    expect(rest).toEqual([]);
    expect(batch?.messages).toHaveLength(1);
    const content = safeTextValue(batch?.messages[0]?.content as never);
    expect(content.startsWith("**Task reminders: Meeting**\n")).toBe(true);
    expect(content).toContain("Two");
  });

  it("holds five tasks to a message, one row of buttons each", () => {
    const lines = Array.from({ length: 12 }, () => line("t"));
    const batches = packBatches(header, lines, asLine);
    expect(batches.map((batch) => batch.items.length)).toEqual([5, 5, 2]);
  });

  it("starts a new batch at the length and mention limits", () => {
    const long = Array.from({ length: 5 }, () => line("x".repeat(900)));
    const many = Array.from({ length: 250 }, (_, index) =>
      line("t", fakeId(index + 10)),
    );
    for (const lines of [long, many]) {
      const batches = packBatches(header, lines, asLine);
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.flatMap((batch) => batch.items)).toEqual(lines);
      for (const batch of batches) {
        expect(batch.messages).toHaveLength(1);
        const [message] = batch.messages;
        expect(
          safeTextValue(message?.content as never).length,
        ).toBeLessThanOrEqual(2000);
        expect(message?.mentionUserIds.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("keeps a long item alone and splits it without a lone header", () => {
    const long = line("word ".repeat(1000));
    const short = line("Short");
    const batches = packBatches(header, [short, long, short], asLine);
    expect(batches.map((batch) => batch.items.length)).toEqual([1, 1, 1]);
    const split = batches[1]?.messages ?? [];
    expect(split.length).toBeGreaterThan(1);
    const first = safeTextValue(split[0]?.content as never);
    expect(first).toContain("Task reminders");
    expect(first).toContain("word");
    expect(split.flatMap((message) => message.mentionUserIds)).toEqual([USER]);
  });
});

describe("the Mark done button", () => {
  function button(description: string) {
    const body = channelMessage({
      content: safe`x`,
      mentionUserIds: [],
      components: [reminder(description).row],
    }).payload as {
      components: { components: { custom_id: string; label: string }[] }[];
    };
    return body.components[0]?.components[0];
  }

  it("names the task, and refers to it by ID alone", () => {
    expect(button("Book the room")).toMatchObject({
      custom_id: `task.done:${TASK}`,
      label: "✅ Done - Book the room",
    });
  });

  it("stays within Discord's limit for a long task", () => {
    const label = button("\u{1F600}".repeat(500))?.label ?? "";
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label).toContain("Done - ");
  });

  it.each(
    HOSTILE_TEXT.filter(([name]) =>
      ["everyone ping", "masked link", "forged line"].includes(name),
    ),
  )("keeps a label inert: %s", (_label, description) => {
    expect(button(description)?.label ?? "").not.toMatch(
      /[@<>#[\]`|*~:/\\.\n\r]/u,
    );
  });

  it("falls back to plain words for invisible text", () => {
    expect(button("ㅤ")?.label).toBe("✅ Mark done");
  });
});
