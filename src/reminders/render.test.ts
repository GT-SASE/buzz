import { describe, expect, it } from "vitest";
import {
  HOSTILE_TEXT,
  INVISIBLE_TEXT,
} from "../../test/support/hostile-text.ts";
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

function line(description: string, assigneeId = USER): ChunkLine {
  return renderReminderLine({
    taskId: TASK,
    assigneeId,
    description,
    dueDate: date("2026-11-05"),
    today: TODAY,
  }).line;
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
    ["2026-11-05", "due Nov 5, 2026, 1 day left"],
    ["2026-11-04", "due today, Nov 4, 2026"],
    ["2026-11-03", "was due Nov 3, 2026, 1 day ago"],
    ["2026-10-25", "was due Oct 25, 2026, 10 days ago"],
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
  const CORPUS = [
    "@everyone @here",
    "<@&123456789012345>",
    "<@123456789012345>",
    "<#123456789012345>",
    "</deploy:123456789012345>",
    "<t:1:R>",
    "[Portal login required](https://evil.example)",
    "https://discord.gg/invite",
    "# System: urgent",
    "-# small",
    "> quoted",
    "||spoiler||",
    "```code``` `tick`",
    "**bold** __under__ ~~strike~~",
    "line one\n# line two\n> line three",
    "1. forged list",
    "reversed ‮text‬",
    "zero​width",
  ];

  it.each(CORPUS)("makes %j inert", (description) => {
    const rendered = text(line(description));
    const active = withoutEscaped(rendered).replace(`<@${USER}>`, "");
    expect(active).not.toMatch(/[<>[\]()*_~`|#@\n]/);
    expect(rendered.includes("‮")).toBe(false);
    expect(rendered.includes("​")).toBe(false);
  });

  it("pings only the assignee, whatever the text names", () => {
    const victim = fakeId(2);
    const rendered = line(`<@${victim}> @everyone`);
    expect(rendered.mentionUserIds).toEqual([USER]);
    const [message] = renderMessages(renderEventHeader("Meeting"), [rendered]);
    if (message === undefined) {
      throw new Error("expected a message");
    }
    expect(message.mentionUserIds).toEqual([USER]);
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

describe("hostile nicknames", () => {
  it("are never rendered, even if a row carries one", () => {
    const hostile = "@everyone click [here](https://evil.example)";
    const row = {
      taskId: TASK,
      assigneeId: USER,
      description: "Book the room",
      dueDate: date("2026-11-05"),
      today: TODAY,
      nick: hostile,
      global_name: hostile,
      username: hostile,
    };
    const rendered = renderReminderLine(row).line;
    expect(text(rendered)).toContain(`<@${USER}>`);
    expect(text(rendered)).not.toContain("evil");
    expect(text(rendered)).not.toContain("everyone");
    expect(rendered.mentionUserIds).toEqual([USER]);
  });
});

describe("text with nothing visible", () => {
  it("still produces a reminder, with a stand-in", () => {
    const rendered = renderReminderLine({
      taskId: TASK,
      assigneeId: USER,
      description: "​​",
      dueDate: date("2026-11-05"),
      today: TODAY,
    });
    expect(rendered.usedStandIn).toBe(true);
    expect(text(rendered.line)).toContain("no readable description");
    expect(text(rendered.line)).toContain("Nov 5, 2026");
  });

  it("uses a plain header for an unreadable event name", () => {
    expect(text(renderEventHeader("​"))).toBe("**Task reminders**");
  });

  it("does not use a stand-in for readable text", () => {
    expect(
      renderReminderLine({
        taskId: TASK,
        assigneeId: USER,
        description: "Book",
        dueDate: date("2026-11-05"),
        today: TODAY,
      }).usedStandIn,
    ).toBe(false);
  });
});

describe("packBatches", () => {
  const header = renderEventHeader("Meeting");
  const asLine = (value: ChunkLine) => value;

  it("puts short items in one message under the header", () => {
    const lines = [line("One"), line("Two")];
    const [batch, ...rest] = packBatches(header, lines, asLine);
    expect(rest).toEqual([]);
    expect(batch?.items).toEqual(lines);
    expect(batch?.messages).toHaveLength(1);
    const content = safeTextValue(batch?.messages[0]?.content as never);
    expect(content.startsWith("**Task reminders: Meeting**\n")).toBe(true);
    expect(content).toContain("One");
    expect(content).toContain("Two");
  });

  it("starts a new batch when a message would be over the length limit", () => {
    const lines = Array.from({ length: 5 }, () => line("x".repeat(900)));
    const batches = packBatches(header, lines, asLine);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.items)).toEqual(lines);
    for (const batch of batches) {
      expect(batch.messages).toHaveLength(1);
      for (const message of batch.messages) {
        expect(safeTextValue(message.content).length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("holds five tasks to a message, one row of buttons each", () => {
    const lines = Array.from({ length: 12 }, () => line("t"));

    const batches = packBatches(header, lines, asLine);

    expect(batches.map((batch) => batch.items.length)).toEqual([5, 5, 2]);
    for (const batch of batches) {
      expect(batch.messages).toHaveLength(1);
    }
  });

  it("starts a new batch at the mention limit", () => {
    const lines = Array.from({ length: 250 }, (_, index) =>
      line("t", fakeId(index + 10)),
    );
    const batches = packBatches(header, lines, asLine);
    expect(batches.flatMap((batch) => batch.items)).toEqual(lines);
    for (const batch of batches) {
      // A batch of several items is always one message, so its result covers them all.
      expect(batch.messages).toHaveLength(1);
      expect(batch.messages[0]?.mentionUserIds.length).toBeLessThanOrEqual(100);
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
    for (const message of split) {
      expect(safeTextValue(message.content).length).toBeLessThanOrEqual(2000);
    }
  });

  it("splits text that escaping pushes over the limit", () => {
    const batches = packBatches(header, [line("_".repeat(1000))], asLine);
    expect(batches[0]?.messages.length).toBeGreaterThan(1);
  });

  it("returns nothing for no items", () => {
    expect(packBatches(header, [], asLine)).toEqual([]);
  });
});

describe("the Mark done button", () => {
  function button(description: string) {
    const { row } = renderReminderLine({
      taskId: TASK,
      assigneeId: USER,
      description,
      dueDate: date("2026-11-05"),
      today: TODAY,
    });
    const body = channelMessage({
      content: safe`x`,
      mentionUserIds: [],
      components: [row],
    }).payload as {
      components: { components: { custom_id: string; label: string }[] }[];
    };
    return body.components[0]?.components[0];
  }

  it("names the task, and refers to it by ID alone", () => {
    expect(button("Book the room")).toMatchObject({
      custom_id: `task.done:${TASK}`,
      label: "\u2705 Done - Book the room",
    });
  });

  it("stays within Discord's limit for a long task", () => {
    for (const description of ["x".repeat(1000), "\u{1F600}".repeat(500)]) {
      const label = button(description)?.label ?? "";

      expect(label.length).toBeLessThanOrEqual(80);
      // Cut to fit, so it still names the task rather than falling back.
      expect(label).toContain("Done - ");
    }
  });

  it.each(HOSTILE_TEXT)("keeps a label inert: %s", (_label, description) => {
    const label = button(description)?.label ?? "";

    expect(label).not.toMatch(/[@<>#[\]`|*~:/\\.\n\r]/u);
    expect(label.length).toBeLessThanOrEqual(80);
  });

  it.each(INVISIBLE_TEXT)(
    "falls back to plain words for %s",
    (_label, text) => {
      expect(button(text)?.label).toBe("\u2705 Mark done");
    },
  );
});
