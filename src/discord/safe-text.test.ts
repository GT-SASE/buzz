import { describe, expect, it } from "bun:test";
import {
  channelMention,
  chunkMessages,
  containsInviteOrMaskedLink,
  DISCORD_LIMITS,
  discordTimestamp,
  escapeUserText,
  isWithinLimit,
  jumpLink,
  plain,
  plainLabel,
  plainTextValue,
  safe,
  SafeTextError,
  safeTextValue,
  textLength,
  truncateUserText,
  roleMention,
  userMention,
} from "./safe-text.ts";
import type { ChunkLine, SafeText } from "./safe-text.ts";
import { fakeId } from "../../test/support/ids.ts";

// The hostile inputs are large enough that linear work ends well inside this limit, and
// heavy quadratic work takes longer. The test timeout cannot interrupt a running regex.
const HOSTILE_INPUT_LIMIT_MS = 15_000;
const HOSTILE_INPUT_TEST_TIMEOUT_MS = 2 * HOSTILE_INPUT_LIMIT_MS;

const render = (raw: string) => safeTextValue(escapeUserText(raw));

/** Whatever is left once escaped pairs are removed has no syntax in it. */
function hasLiveSyntax(text: string): boolean {
  const unescaped = text.replace(/\\[\s\S]/gu, "");
  return /[<>@*_~`|#[\]()\\:/\p{Cc}\p{Cf}]/u.test(unescaped);
}

const ID = fakeId(1);

const CORPUS = [
  "@everyone",
  `<@&${ID}>`,
  "<t:1700000000:R>",
  "**bold** *it* __under__ ~~gone~~ ||hidden||",
  "`code` ``` fenced ```",
  "-# small print",
  ">>> quote",
  "line one\nSystem: line two",
  "[Portal login required](https://evil.example)",
  "discord.gg/abcd",
  "\u{202E}gnp.exe",
  "tag\u{E0041}\u{E0042}",
  "\\\\<@1>",
  "\uD800lone",
];

describe("escapeUserText", () => {
  it.each(CORPUS)("leaves no live syntax in %j", (raw) => {
    expect(hasLiveSyntax(render(raw))).toBe(false);
  });

  it.each([
    ["@everyone", String.raw`\@everyone`],
    ["-# small", String.raw`\-\# small`],
    ["1. one", String.raw`1\. one`],
    ["[a](https://b.c)", String.raw`\[a\]\(https\:\/\/b\.c\)`],
    [`<@&${ID}>`, String.raw`\<\@&` + ID + String.raw`\>`],
  ])("renders %j as %j", (raw, expected) => {
    expect(render(raw)).toBe(expected);
  });

  it("leaves ordinary sentences alone and collapses line breaks", () => {
    expect(render("Bring snacks, please! Is 5 ok? It's fine.")).toBe(
      "Bring snacks, please! Is 5 ok? It's fine.",
    );
    expect(render("a\n\n b\r\nc\u{2028}d\t\te\u{A0}\u{A0}f")).toBe(
      "a b c d e f",
    );
  });

  it("keeps ZWJ and VS16 inside an emoji, and removes them elsewhere", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

    expect(render(family)).toBe(family);
    expect(render("\u{2764}\u{FE0F}")).toBe("\u{2764}\u{FE0F}");
    expect(render("a\u{200D}b")).toBe("ab");
    expect(render("a\u{FE0F}b")).toBe("ab");
  });

  it.each([
    ["the combining grapheme joiner", "a\u{34F}b"],
    ["an unassigned code point", "a\u{50000}b"],
    ["a Hangul filler", "a\u{3164}b"],
  ])("removes %s", (_label, raw) => {
    expect(render(raw)).toBe("ab");
  });

  it.each(["", "\u{200B}\u{200C}\u{200D}\u{FEFF}", "\u{3164}", "́", "\uD800"])(
    "refuses %j, which has nothing visible",
    (raw) => {
      expect(() => escapeUserText(raw)).toThrow(SafeTextError);
    },
  );

  it("checks the length after stripping, without repeating the text", () => {
    expect(() =>
      escapeUserText(`${"x".repeat(2000)}${"\u{200B}".repeat(50)}`),
    ).not.toThrow();
    // 100 code points, which a char_length rule would accept.
    expect(isWithinLimit("\u{1F600}".repeat(100), 100)).toBe(false);
    expect(() => escapeUserText("private".repeat(400))).toThrow(
      /^Text is 2800 long, the limit is 2000$/,
    );
  });

  it("limits a stack of combining marks, and normalises after stripping", () => {
    expect(render(`a${"̖".repeat(5000)}`)).toBe(`a${"̖".repeat(8)}`);
    expect(render("e​́")).toBe("é");
  });

  it(
    "stays quick on long hostile input",
    () => {
      const started = performance.now();
      truncateUserText("\u{200D}".repeat(200_000) + "<@".repeat(200_000), 2000);
      containsInviteOrMaskedLink("discord.".repeat(50_000));
      containsInviteOrMaskedLink("]".repeat(400_000));

      expect(performance.now() - started).toBeLessThan(HOSTILE_INPUT_LIMIT_MS);
    },
    HOSTILE_INPUT_TEST_TIMEOUT_MS,
  );
});

describe("truncateUserText", () => {
  it("cuts to fit after escaping, without splitting an escape", () => {
    const text = safeTextValue(truncateUserText("@".repeat(100), 11));

    expect(text).toBe(`${String.raw`\@`.repeat(5)}…`);
    expect(textLength(text)).toBeLessThanOrEqual(11);
  });

  it("does not split an emoji sequence", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

    expect(safeTextValue(truncateUserText(family.repeat(3), 20))).toBe(
      `${family}${family}…`,
    );
  });

  it("keeps the full stop escape when it cuts", () => {
    expect(safeTextValue(truncateUserText("1. item and more", 8))).toBe(
      String.raw`1\. ite` + "…",
    );
    expect(safeTextValue(truncateUserText("discord.gg/abc", 40))).toBe(
      String.raw`discord\.gg\/abc`,
    );
  });

  it("refuses when nothing fits or nothing is visible", () => {
    expect(() => truncateUserText("@@@", 2)).toThrow(SafeTextError);
    expect(() => truncateUserText("\u{200B}", 10)).toThrow(SafeTextError);
  });

  it("shows the start of one grapheme longer than the limit", () => {
    const man = "\u{1F468}";
    const joiner = "\u{200D}";
    const jamo = safeTextValue(truncateUserText("ᄀ".repeat(300), 200));
    const chain = safeTextValue(
      truncateUserText(`${man}${joiner}`.repeat(150) + man, 200),
    );

    expect(jamo).toBe(`${"ᄀ".repeat(199)}…`);
    expect(chain).toBe(`${`${man}${joiner}`.repeat(65)}${man}…`);
    expect(safeTextValue(truncateUserText(`ab${"ᄀ".repeat(300)}`, 200))).toBe(
      "ab…",
    );
  });
});

describe("plainLabel", () => {
  const label = (raw: string, max?: number) =>
    plainTextValue(plainLabel(raw, max));

  it.each([
    ["@everyone meeting", "everyone meeting"],
    ["https://evil.example/x", "https evil example x"],
    [`<@&${ID}> call`, `&${ID} call`],
    ["Spring @́\u{FE0F}Mixer", "Spring Mixer"],
    ["Spring Mixer - Week 3 (Fri)", "Spring Mixer - Week 3 (Fri)"],
    ["Café Nuit", "Café Nuit"],
  ])("makes %j into %j", (raw, expected) => {
    expect(label(raw)).toBe(expected);
  });

  it.each(["", "@@@", "\u{3164}"])(
    "refuses %j, which leaves nothing usable",
    (raw) => {
      expect(() => plainLabel(raw)).toThrow(SafeTextError);
    },
  );

  it("measures the length after normalising", () => {
    expect(label(`${"x".repeat(100)}@@@`)).toHaveLength(100);
    expect(() => plainLabel("x".repeat(101))).toThrow(SafeTextError);
    expect(() => label("\u{1F389}".repeat(51))).toThrow(SafeTextError);
  });
});

describe("containsInviteOrMaskedLink", () => {
  it.each([
    "DISCORD.GG/abc",
    "discord.com/invite/abc",
    "[Portal login](https://evil.example)",
    "discord.​gg/abc",
    "[log in]͏(evil)",
  ])("finds %j", (text) => {
    expect(containsInviteOrMaskedLink(text)).toBe(true);
  });

  it.each([
    "https://forms.example/sign-up",
    "Budget (draft) [v2]",
    "discord.com/channels/1/2",
  ])("leaves %s alone", (text) => {
    expect(containsInviteOrMaskedLink(text)).toBe(false);
  });
});

describe("the safe tag", () => {
  it("joins source text with SafeText values", () => {
    const text = safe`Due: ${escapeUserText("a*b")} for ${userMention(ID)}`;

    expect(safeTextValue(text)).toBe(String.raw`Due: a\*b for <@` + ID + ">");
  });

  it("refuses a plain string, in the types and at runtime", () => {
    const hostile = "@everyone";

    // @ts-expect-error A plain string must not reach message text.
    expect(() => safe`Due: ${hostile}`).toThrow(SafeTextError);
    expect(() =>
      safe(["@everyone"] as unknown as TemplateStringsArray),
    ).toThrow(SafeTextError);
    // @ts-expect-error A plain string is not SafeText.
    expect(() => safeTextValue("@everyone")).toThrow();
    // @ts-expect-error A label is not message text.
    expect(() => safeTextValue(plain`Label`)).toThrow(SafeTextError);
    // @ts-expect-error A plain string is not a label.
    expect(() => plainTextValue("@everyone")).toThrow();
  });

  it("cannot be forged through the constructor", () => {
    const Forge = escapeUserText("x").constructor as new (
      ...args: unknown[]
    ) => SafeText;
    class Forged extends Forge {}

    expect(() => new Forge(Symbol("SafeText"), "@everyone")).toThrow(
      SafeTextError,
    );
    expect(() => new Forged("@everyone")).toThrow(SafeTextError);
  });

  it("does not show its value through JSON", () => {
    const text = escapeUserText("visible");

    expect(JSON.stringify(text)).toBe("{}");
    expect(Object.isFrozen(text)).toBe(true);
  });
});

describe("mentions and links", () => {
  it("renders live mention syntax only for a valid ID", () => {
    expect(safeTextValue(userMention(ID))).toBe(`<@${ID}>`);
    expect(safeTextValue(channelMention(ID))).toBe(`<#${ID}>`);
    expect(safeTextValue(roleMention(ID))).toBe(`<@&${ID}>`);
    expect(() => roleMention("everyone")).toThrow(SafeTextError);
    expect(() => userMention(`${ID}><@&1`)).toThrow(SafeTextError);
    expect(() => channelMention("1")).toThrow(SafeTextError);
  });

  it("accepts a link to a message", () => {
    const url = `https://discord.com/channels/${ID}/${ID}/${ID}`;

    expect(safeTextValue(jumpLink(url))).toBe(url);
  });

  it.each([
    "https://discord.com.evil.example/channels/1/2/3",
    "https://discord.com/channels/1/2/3 [x](https://evil.example)",
    "https://discord.com/invite/abc",
  ])("refuses %j as a link", (url) => {
    expect(() => jumpLink(url)).toThrow(SafeTextError);
  });
});

describe("discordTimestamp", () => {
  const instant = Date.UTC(2026, 10, 3, 22, 30);

  it("builds the tag from a number, in whole seconds", () => {
    expect(safeTextValue(discordTimestamp(instant, "t"))).toBe(
      `<t:${String(instant / 1000)}:t>`,
    );
    expect(safeTextValue(discordTimestamp(instant + 999, "R"))).toBe(
      `<t:${String(instant / 1000)}:R>`,
    );
  });

  it("refuses a bad instant or a style Discord does not have", () => {
    expect(() => discordTimestamp(Number.NaN, "t")).toThrow(SafeTextError);
    expect(() => discordTimestamp(1e30, "t")).toThrow(SafeTextError);
    expect(() =>
      discordTimestamp(instant, "x>" as Parameters<typeof discordTimestamp>[1]),
    ).toThrow(SafeTextError);
  });

  it("cannot be made from user text", () => {
    expect(safeTextValue(escapeUserText("<t:1793745000:t>"))).toBe(
      String.raw`\<t\:1793745000\:t\>`,
    );
  });

  it("is never split across messages", () => {
    const tag = discordTimestamp(instant, "F");
    const text = safe`${escapeUserText("x".repeat(5))}${tag}${tag}`;
    const chunks = chunkMessages([{ text, mentionUserIds: [] }], {
      maxLength: 24,
    }).map((chunk) => safeTextValue(chunk.content));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(safeTextValue(text));
    for (const chunk of chunks) {
      expect(chunk.replace(/<t:[0-9]+:F>/g, "")).toMatch(/^x*$/);
    }
  });
});

describe("chunkMessages", () => {
  const line = (text: SafeText, mentionUserIds: readonly string[] = []) => ({
    text,
    mentionUserIds,
  });
  const contents = (chunks: ReturnType<typeof chunkMessages>) =>
    chunks.map((chunk) => safeTextValue(chunk.content));

  it("keeps lines together and moves a line rather than splitting it", () => {
    expect(
      contents(
        chunkMessages([
          line(escapeUserText("one")),
          line(escapeUserText("two")),
        ]),
      ),
    ).toEqual(["one\ntwo"]);
    expect(
      contents(
        chunkMessages(
          [line(escapeUserText("aaaa")), line(escapeUserText("bbbb"))],
          { maxLength: 6 },
        ),
      ),
    ).toEqual(["aaaa", "bbbb"]);
  });

  it("never splits a mention, an escape or an emoji", () => {
    const mention = userMention(ID);
    const mentions = contents(
      chunkMessages(
        [
          line(
            safe`${escapeUserText("x".repeat(5))}${mention}${mention}${mention}`,
            [ID],
          ),
        ],
        { maxLength: 30 },
      ),
    );
    const escapes = contents(
      chunkMessages([line(escapeUserText("@".repeat(20)))], { maxLength: 7 }),
    );
    const faces = contents(
      chunkMessages([line(escapeUserText("\u{1F600}".repeat(5)))], {
        maxLength: 3,
      }),
    );

    for (const chunk of mentions) {
      expect(chunk.replace(new RegExp(`<@${ID}>`, "g"), "")).toMatch(/^x*$/);
    }
    for (const chunk of escapes) {
      expect(chunk).toMatch(/^(\\@)+$/);
    }
    expect(faces).toEqual(Array.from({ length: 5 }, () => "\u{1F600}"));
  });

  it("neutralises a line start at the head of a continuation chunk", () => {
    const continuation = (literal: SafeText) =>
      contents(
        chunkMessages(
          [line(safe`${escapeUserText("a".repeat(12))} ${literal}`)],
          { maxLength: 12 },
        ),
      );

    expect(continuation(safe`# title`)).toEqual([
      "a".repeat(12),
      String.raw`\# title`,
    ]);
    expect(continuation(safe`>>> quote`)).toEqual([
      "a".repeat(12),
      String.raw`\>>> quote`,
    ]);
  });

  it("stays within the mention limit on one line", () => {
    const ids = Array.from({ length: 250 }, (_, index) => fakeId(index));
    const text = ids.reduce(
      (joined, id) => safe`${joined} ${userMention(id)}`,
      escapeUserText("Due"),
    );

    const chunks = chunkMessages([line(text, ids)]);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.mentionUserIds.length).toBeLessThanOrEqual(100);
      expect(safeTextValue(chunk.content).length).toBeLessThanOrEqual(2000);
      const shown = safeTextValue(chunk.content).match(/<@[0-9]+>/g) ?? [];
      expect(shown).toHaveLength(chunk.mentionUserIds.length);
    }
    expect(chunks.flatMap((chunk) => chunk.mentionUserIds).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("pings only users who are both named and shown", () => {
    const other = fakeId(2);
    const chunks = chunkMessages(
      [
        line(safe`${userMention(ID)} one`, [ID]),
        line(safe`${userMention(other)} two`, [other]),
      ],
      { maxLength: 30 },
    );

    expect(chunks.map((chunk) => chunk.mentionUserIds)).toEqual([
      [ID],
      [other],
    ]);
    expect(
      chunkMessages([line(safe`${userMention(ID)}`, [])])[0]?.mentionUserIds,
    ).toEqual([]);
    expect(
      chunkMessages([line(safe`nobody`, [ID])])[0]?.mentionUserIds,
    ).toEqual([]);
  });

  describe("around a line too long for one message", () => {
    const [A, B, C] = [fakeId(11), fakeId(12), fakeId(13)] as const;
    const said = (id: string, word: string) =>
      line(safe`${userMention(id)} ${escapeUserText(word)}`, [id]);
    const shown = (id: string) => `<@${id}>`;
    const xs = (count: number) => "x".repeat(count);
    const underscores = (count: number) => String.raw`\_`.repeat(count);

    // Each mention is 21 long, so a limit of 30 holds one mention and a short word.
    it.each<{
      name: string;
      lines: readonly ChunkLine[];
      maxLength: number;
      expected: (string | readonly string[])[][];
    }>([
      {
        name: "short, oversized, short",
        lines: [said(A, "one"), said(B, xs(20)), said(C, "two")],
        maxLength: 30,
        expected: [
          [`${shown(A)} one`, [A]],
          [shown(B), [B]],
          [xs(20), []],
          [`${shown(C)} two`, [C]],
        ],
      },
      {
        name: "a legal 1000-character description at Discord's limit",
        lines: [said(A, "one"), said(B, "_".repeat(1000)), said(C, "two")],
        maxLength: DISCORD_LIMITS.content,
        expected: [
          [`${shown(A)} one`, [A]],
          [`${shown(B)} ${underscores(989)}`, [B]],
          [underscores(11), []],
          [`${shown(C)} two`, [C]],
        ],
      },
    ])("$name", ({ lines, maxLength, expected }) => {
      const chunks = chunkMessages(lines, { maxLength });

      expect(
        chunks.map((chunk) => [
          safeTextValue(chunk.content),
          chunk.mentionUserIds,
        ]),
      ).toEqual(expected);
      for (const chunk of chunks) {
        expect(textLength(safeTextValue(chunk.content))).toBeLessThanOrEqual(
          maxLength,
        );
      }
    });
  });

  it("makes nothing from no lines, and refuses an atom that cannot fit", () => {
    expect(chunkMessages([])).toEqual([]);
    expect(() =>
      chunkMessages([line(userMention(ID))], { maxLength: 5 }),
    ).toThrow(SafeTextError);
  });
});
