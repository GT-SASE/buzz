import { describe, expect, it } from "vitest";

import { csvCell, toCsv } from "~/app/portal/_lib/csv";

/**
 * A member's display name comes from their Google profile, so a member picks
 * the text that lands in an officer's spreadsheet. Excel and Sheets execute a
 * cell beginning `=`, `+`, `-`, `@`, tab or CR as a formula; quoting alone does
 * not stop it, the leading apostrophe does. Each trigger is asserted on its own
 * so a failure names the character that got through.
 */
describe("csvCell", () => {
  it("neutralises a leading equals sign", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
  });

  it("neutralises a leading plus sign", () => {
    expect(csvCell("+1+1")).toBe(`"'+1+1"`);
  });

  it("neutralises a leading minus sign", () => {
    expect(csvCell("-1+1")).toBe(`"'-1+1"`);
    // Numbers take the same path as text, so a negative number is quoted as
    // text too. That is what the officer's export does today.
    expect(csvCell(-5)).toBe(`"'-5"`);
  });

  it("neutralises a leading at sign", () => {
    expect(csvCell("@SUM(A1:A9)")).toBe(`"'@SUM(A1:A9)"`);
  });

  it("neutralises a leading tab", () => {
    expect(csvCell("\t=1+1")).toBe(`"'\t=1+1"`);
  });

  it("neutralises a leading carriage return", () => {
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("keeps every original character after the guard", () => {
    const name = "=Ada Lovelace";
    const cell = csvCell(name);

    expect(cell).toBe(`"'=Ada Lovelace"`);
    // Nothing is dropped or rewritten: the apostrophe is a prefix, and
    // spreadsheets strip it from the displayed value.
    expect(cell.slice(2, -1)).toBe(name);
  });

  it("doubles an inner double quote and keeps the cell quoted", () => {
    expect(csvCell(`Grace "Amazing" Hopper`)).toBe(
      `"Grace ""Amazing"" Hopper"`,
    );
    expect(csvCell(`"`)).toBe(`""""`);
  });

  it("writes an empty cell for null and undefined, not the word", () => {
    expect(csvCell(null)).toBe(`""`);
    expect(csvCell(undefined)).toBe(`""`);
    // `??`, not `||`: zero points is a number, not a missing value.
    expect(csvCell(0)).toBe(`"0"`);
  });

  it("quotes an ordinary value without touching it", () => {
    expect(csvCell("Grace Hopper")).toBe(`"Grace Hopper"`);
    expect(csvCell("grace@gatech.edu")).toBe(`"grace@gatech.edu"`);
    expect(csvCell(30)).toBe(`"30"`);
  });
});

describe("toCsv", () => {
  it("separates rows with CRLF and cells with a comma", () => {
    expect(
      toCsv([
        ["Name", "Email", "Points"],
        ["Grace Hopper", "grace@gatech.edu", 30],
      ]),
    ).toBe(`"Name","Email","Points"\r\n"Grace Hopper","grace@gatech.edu","30"`);
  });

  it("escapes every cell it joins", () => {
    expect(toCsv([["=1+1", null]])).toBe(`"'=1+1",""`);
  });

  it("emits nothing for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});
