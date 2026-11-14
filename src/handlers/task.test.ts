import { describe, expect, it } from "bun:test";
import { COMMANDS } from "./registry.ts";

function optionNames(command: string, sub?: string): string[] {
  const definition = COMMANDS.find((item) => item.name === command);
  const { options = [] } = (definition ?? {}) as {
    options?: { name: string; options?: { name: string }[] }[];
  };
  const list =
    sub === undefined
      ? options
      : (options.find((option) => option.name === sub)?.options ?? []);
  return list.map((option) => option.name);
}

describe("the commands as registered", () => {
  it("gives /mytasks no options, and each /task subcommand only what it needs", () => {
    expect(optionNames("mytasks")).toEqual([]);
    expect(optionNames("task").sort()).toEqual([
      "assign",
      "delete",
      "done",
      "edit",
    ]);
    expect(optionNames("task", "assign")).toEqual([
      "person",
      "description",
      "due",
      "event",
    ]);
    expect(optionNames("task", "edit")).toEqual([
      "task",
      "description",
      "due",
      "person",
    ]);
    expect(optionNames("task", "done")).toEqual(["task"]);
  });
});
