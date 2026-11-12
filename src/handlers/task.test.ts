import { describe, expect, it } from "vitest";
import { COMMANDS } from "./registry.ts";

describe("the commands as registered", () => {
  function optionNames(command: string, sub?: string): string[] {
    const definition = COMMANDS.find((item) => item.name === command);
    const { options = [] } = (definition ?? {}) as {
      options?: { name: string; options?: { name: string }[] }[];
    };
    return sub === undefined
      ? options.map((option) => option.name)
      : (options
          .find((option) => option.name === sub)
          ?.options?.map((option) => option.name) ?? []);
  }

  it("gives /mytasks no options, so it can only mean the caller", () => {
    expect(optionNames("mytasks")).toEqual([]);
  });

  it("offers only the options each subcommand needs", () => {
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
    expect(optionNames("task", "delete")).toEqual(["task"]);
    expect(optionNames("task", "done")).toEqual(["task"]);
  });
});
