import { describe, expect, it } from "vitest";
import {
  channelMention,
  chunkMessages,
  containsInviteOrMaskedLink,
  DISCORD_LIMITS,
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

// The hostile inputs are large enough that linear work ends well inside this limit, even
// if it can take several seconds on a busy machine, and heavy quadratic work takes longer.
// A mildly quadratic pattern can pass. A badly slow one may hang the job rather than fail
// quickly, because the test timeout cannot interrupt a regex that is running.
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
  "@here please",
  `<@${ID}>`,
  `<@!${ID}>`,
  `<@&${ID}>`,
  `<#${ID}>`,
  `</deploy:${ID}>`,
  "<t:1700000000:R>",
  `<:name:${ID}>`,
  `<a:name:${ID}>`,
  "<id:customize>",
  "**bold** *it* __under__ ~~gone~~ ||hidden||",
  "`code` ``` fenced ```",
  "# Header",
  "## Header",
  "### Header",
  "-# small print",
  "> quote",
  ">>> quote",
  "- list",
  "* list",
  "+ list",
  "1. list",
  "line one\nSystem: line two",
  "a\r\nb\u{2028}c\u{2029}d\u0085e\vf\fg",
  "[Portal login required](https://evil.example)",
  "[x](<https://evil.example>)",
  "https://evil.example/a_b",
  "discord.gg/abcd",
  "evil.example",
  "\u{202E}gnp.exe",
  "a\u{200B}b",
  "a\u{2066}b\u{2069}c",
  "a\u{FEFF}b",
  "tag\u{E0041}\u{E0042}",
  "\\@everyone",
  "\\\\<@1>",
  "\uD800lone",
  "lone\uDC00",
];

describe("escapeUserText", () => {
  it.each(CORPUS)("leaves no live syntax in %j", (raw) => {
    expect(hasLiveSyntax(render(raw))).toBe(false);
  });

  it.each([
    ["@everyone", String.raw`\@everyone`],
    ["# Header", String.raw`\# Header`],
    ["-# small", String.raw`\-\# small`],
    ["> quote", String.raw`\> quote`],
    ["||x||", String.raw`\|\|x\|\|`],
    ["1. one", String.raw`1\. one`],
    ["evil.example", String.raw`evil\.example`],
    ["[a](https://b.c)", String.raw`\[a\]\(https\:\/\/b\.c\)`],
    [`<@&${ID}>`, String.raw`\<\@&` + ID + String.raw`\>`],
    ["back\\slash", String.raw`back\\slash`],
  ])("renders %j as %j", (raw, expected) => {
    expect(render(raw)).toBe(expected);
  });

  it("leaves ordinary sentences alone", () => {
    expect(render("Bring snacks, please! Is 5 ok? It's fine.")).toBe(
      "Bring snacks, please! Is 5 ok? It's fine.",
    );
  });

  it("composes accents with NFC", () => {
    expect(render("é")).toBe("é");
  });

  it("collapses every kind of line break and run of space", () => {
    expect(render("a\n\n b\r\nc\u{2028}d\t\te\u{A0}\u{A0}f")).toBe(
      "a b c d e f",
    );
  });

  it.each([
    ["family", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"],
    ["with a skin tone", "\u{1F468}\u{1F3FD}\u{200D}\u{1F4BB}"],
    ["with a variation selector", "⛹\u{FE0F}\u{200D}♂\u{FE0F}"],
    ["keycap", "1\u{FE0F}⃣"],
  ])("keeps ZWJ inside an emoji sequence: %s", (_label, emoji) => {
    expect(render(emoji)).toBe(emoji);
  });

  it.each([
    ["between letters", "a\u{200D}b", "ab"],
    ["before an emoji", "a\u{200D}\u{1F600}", "a\u{1F600}"],
    ["after an emoji", "\u{1F600}\u{200D}a", "\u{1F600}a"],
    ["a variation selector on a letter", "a\u{FE0F}b", "ab"],
  ])("removes ZWJ and selectors elsewhere: %s", (_label, raw, expected) => {
    expect(render(raw)).toBe(expected);
  });

  it.each([
    ["the combining grapheme joiner", "a\u{34F}b"],
    ["a variation selector other than VS16", "a\u{FE00}b"],
    ["VS15", "a\u{FE0E}b"],
    ["a supplementary variation selector", "a\u{E0100}b"],
    ["the object replacement character", "a\u{FFFC}b"],
    ["the null notehead", "a\u{1D159}b"],
    ["the Mongolian vowel separator", "a\u{180E}b"],
  ])("removes %s", (_label, raw) => {
    expect(render(raw)).toBe("ab");
  });

  it.each([
    "",
    "   ",
    "\n\n",
    "\u{200B}",
    "\u{200B}\u{200C}\u{200D}\u{FEFF}",
    "\u{202E}",
    "\u{E0041}",
    "\u{3164}",
    "\u{115F}",
    "\u{FFA0}",
    "\u{2800}",
    "\u{AD}",
    "́",
    "\uD800",
  ])("refuses %j, which has nothing visible", (raw) => {
    expect(() => escapeUserText(raw)).toThrow(SafeTextError);
  });

  it("checks the length after stripping", () => {
    expect(() =>
      escapeUserText(`${"x".repeat(2000)}${"\u{200B}".repeat(50)}`),
    ).not.toThrow();
    expect(() => escapeUserText("x".repeat(2001))).toThrow(SafeTextError);
    expect(() => escapeUserText("xxx", 2)).toThrow(SafeTextError);
  });

  it("does not repeat refused text", () => {
    expect(() => escapeUserText("private".repeat(400))).toThrow(
      /^Text is 2800 long, the limit is 2000$/,
    );
  });

  it(
    "stays quick on long hostile input",
    () => {
      const hostile = "\u{200D}".repeat(200_000) + "<@".repeat(200_000);

      const started = performance.now();
      truncateUserText(hostile, 2000);

      expect(performance.now() - started).toBeLessThan(HOSTILE_INPUT_LIMIT_MS);
    },
    HOSTILE_INPUT_TEST_TIMEOUT_MS,
  );
});

describe("truncateUserText", () => {
  it("returns short text whole", () => {
    expect(safeTextValue(truncateUserText("short", 10))).toBe("short");
  });

  it("cuts to fit after escaping, without splitting an escape", () => {
    const text = safeTextValue(truncateUserText("@".repeat(100), 11));

    expect(text).toBe(`${String.raw`\@`.repeat(5)}…`);
    expect(textLength(text)).toBeLessThanOrEqual(11);
  });

  it("does not split a surrogate pair or an emoji sequence", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

    expect(safeTextValue(truncateUserText(family.repeat(3), 20))).toBe(
      `${family}${family}…`,
    );
  });

  it("refuses when nothing fits or nothing is visible", () => {
    expect(() => truncateUserText("@@@", 1)).toThrow(SafeTextError);
    expect(() => truncateUserText("@@@", 2)).toThrow(SafeTextError);
    expect(() => truncateUserText("\u{200B}", 10)).toThrow(SafeTextError);
  });

  describe("one grapheme longer than the limit", () => {
    const man = "\u{1F468}";
    const joiner = "\u{200D}";
    const face = "\u{1F600}";
    const lightSkin = "\u{1F3FB}";

    it.each([
      ["a run of Hangul jamo", "ᄀ".repeat(300), "ᄀ".repeat(199)],
      [
        "a chain of joined emoji, with no joiner left at the end",
        `${man}${joiner}`.repeat(150) + man,
        `${man}${joiner}`.repeat(65) + man,
      ],
      [
        "a chain of two-unit code points, without splitting one",
        face + lightSkin.repeat(300),
        face + lightSkin.repeat(98),
      ],
    ])("shows the start of %s", (_label, raw, expected) => {
      const text = safeTextValue(truncateUserText(raw, 200));

      expect(text).toBe(`${expected}…`);
      expect(textLength(text)).toBeLessThanOrEqual(200);
    });

    it("keeps the graphemes before it and does not cut it", () => {
      const raw = `ab${"ᄀ".repeat(300)}`;

      expect(safeTextValue(truncateUserText(raw, 200))).toBe("ab…");
    });

    it("refuses when the cut would leave nothing visible", () => {
      // The combining mark is all that fits, and it shows nothing by itself.
      const raw = `́${"ﾞ".repeat(10)}`;

      expect(() => truncateUserText(raw, 2)).toThrow(SafeTextError);
    });

    it.each([
      ["one mark", "\u0301"],
      ["eight marks", "\u0301".repeat(8)],
      ["marks and a space", "\u0301\u0301 "],
    ])("shows the start of it when all before it is %s", (_label, start) => {
      const raw = `${start}${"\u1100".repeat(300)}`;
      const text = safeTextValue(truncateUserText(raw, 200));

      expect(text).toBe(
        `${start}${"\u1100".repeat(199 - textLength(start))}\u2026`,
      );
      expect(textLength(text)).toBe(200);
    });

    it("shows the start of a joined emoji chain after a stray mark", () => {
      const raw = `\u0301${`${man}${joiner}`.repeat(150)}${man}`;

      expect(safeTextValue(truncateUserText(raw, 200))).toBe(
        `\u0301${`${man}${joiner}`.repeat(65)}${man}\u2026`,
      );
    });

    it("refuses when only an escape follows a stray mark", () => {
      expect(() => truncateUserText("\u0301@", 2)).toThrow(SafeTextError);
    });

    it("refuses when the limit has no room beside the ellipsis", () => {
      expect(() => truncateUserText("ᄀ".repeat(300), 1)).toThrow(
        SafeTextError,
      );
    });
  });
});

describe("review regressions", () => {
  it.each([
    ["1. x", 12, String.raw`1\. x`],
    ["10. x", 12, String.raw`10\. x`],
    ["a.com", 12, String.raw`a\.com`],
    ["discord.gg/abc", 40, String.raw`discord\.gg\/abc`],
  ])("truncation keeps the full stop escape for %j", (raw, max, expected) => {
    expect(safeTextValue(truncateUserText(raw, max))).toBe(expected);
  });

  it.each([
    ["1. item and much more text", 8, String.raw`1\. ite…`],
    ["a.com and more and more", 8, String.raw`a\.com …`],
    ["discord.gg/abc and more", 14, String.raw`discord\.gg\/…`],
  ])("truncation escapes %j when it cuts", (raw, max, expected) => {
    expect(safeTextValue(truncateUserText(raw, max))).toBe(expected);
  });

  it.each([
    ["a digit with a variation selector", "1\u{FE0F}. x", "1\u{FE0F}\\. x"],
    ["a mark before a letter", "a.́com", "a\\.́com"],
  ])("escapes a full stop after %s", (_label, raw, expected) => {
    expect(render(raw)).toBe(expected);
  });

  it("limits a stack of combining marks", () => {
    const stacked = render(`a${"̖".repeat(5000)}`);

    expect(stacked).toBe(`a${"̖".repeat(8)}`);
  });

  it("does not abort a batch over oversized combining marks", () => {
    const text = escapeUserText(`a${"̖".repeat(5000)} b`);

    const chunks = chunkMessages([{ text, mentionUserIds: [] }], {
      maxLength: 12,
    });

    expect(chunks.length).toBeGreaterThan(0);
  });

  it("normalises after stripping", () => {
    expect(render("e​́")).toBe("é");
  });

  it.each([
    ["an unassigned code point", "a\u{50000}b", "ab"],
    ["a null notehead", "a\u{1D159}b", "ab"],
    ["an object replacement", "a\u{FFFC}b", "ab"],
    ["a variation selector", "a\u{FE00}b", "ab"],
    ["a combining grapheme joiner", "a\u{034F}b", "ab"],
    ["a Mongolian vowel separator", "a\u{180E}b", "ab"],
    ["a Hangul filler", "a\u{3164}b", "ab"],
  ])("strips %s", (_label, raw, expected) => {
    expect(render(raw)).toBe(expected);
  });

  it.each(["\u{1D159}", "\u{FFFC}", "\u{50000}", "\u{034F}", "\u{3164}"])(
    "refuses %j, which has nothing visible",
    (raw) => {
      expect(() => escapeUserText(raw)).toThrow(SafeTextError);
    },
  );

  it("keeps the joiner and VS16 inside an emoji", () => {
    expect(render("\u{1F469}\u{200D}\u{1F4BB}")).toBe(
      "\u{1F469}\u{200D}\u{1F4BB}",
    );
    expect(render("\u{2764}\u{FE0F}")).toBe("\u{2764}\u{FE0F}");
  });

  it.each([
    ["́Mixer", "Mixer"],
    ["@́Mixer", "Mixer"],
    ["Spring @́\u{FE0F}Mixer", "Spring Mixer"],
  ])("removes marks left at the start of a word in %j", (raw, expected) => {
    expect(plainTextValue(plainLabel(raw))).toBe(expected);
  });

  const hard = (text: SafeText) => ({ text, mentionUserIds: [] });
  const continuation = (literal: SafeText) =>
    chunkMessages([hard(safe`${escapeUserText("a".repeat(12))} ${literal}`)], {
      maxLength: 12,
    }).map((chunk) => safeTextValue(chunk.content));

  it.each([
    [safe`# title`, String.raw`\# title`],
    [safe`### title`, String.raw`\### title`],
    [safe`-# small`, String.raw`\-# small`],
    [safe`- item`, String.raw`\- item`],
    [safe`* item`, String.raw`\* item`],
    [safe`+ item`, String.raw`\+ item`],
    [safe`> quote`, String.raw`\> quote`],
    [safe`>>> quote`, String.raw`\>>> quote`],
    [safe`12. item`, String.raw`12\. item`],
  ])(
    "neutralises the start of a continuation chunk %#",
    (literal, expected) => {
      expect(continuation(literal)).toEqual(["a".repeat(12), expected]);
    },
  );

  it("stays inside the limit after neutralising a line start", () => {
    const chunks = continuation(safe`# 123456789 1234567890`);

    for (const text of chunks) {
      expect(text.length).toBeLessThanOrEqual(12);
    }
  });

  it("keeps room for the escape when a marker would fill a chunk", () => {
    const chunks = chunkMessages([hard(safe`aaaaaaaaaa # 1234567890`)], {
      maxLength: 12,
    }).map((chunk) => safeTextValue(chunk.content));

    expect(chunks.length).toBeGreaterThan(1);
    for (const text of chunks) {
      expect(text.length).toBeLessThanOrEqual(12);
    }
  });

  it("leaves the first chunk alone", () => {
    const [first] = chunkMessages([hard(safe`# title and more words`)], {
      maxLength: 12,
    });

    expect(first && safeTextValue(first.content)).toBe("# title and");
  });

  it("keeps the ping of a mention right after a link", () => {
    const url = `https://discord.com/channels/${ID}/${ID}/${ID}`;
    const text = safe`${jumpLink(url)}${userMention(ID)}`;

    const chunks = chunkMessages([{ text, mentionUserIds: [ID] }]);

    expect(chunks[0]?.mentionUserIds).toEqual([ID]);
  });
});

describe("containsInviteOrMaskedLink", () => {
  it.each([
    "discord.gg/abc",
    "DISCORD.GG/abc",
    "discord.com/invite/abc",
    "discordapp.com/invite/abc",
    "dsc.gg/abc",
    "[log in](evil)",
    "[Portal login](https://evil.example)",
    "discord.\u200Bgg/abc",
    "discord\uFE00.gg/x",
    "discord.\u034Fgg/x",
    "[log in]\u200B(evil)",
    "disc\u034Ford.gg/x",
    "[log in]\u034F(evil)",
    "[log in](\u034Fevil)",
    "discord\uFFFC.gg/x",
    "discord.\u{1D159}gg/x",
    "discord\u{E0100}.gg/x",
  ])("finds %j", (text) => {
    expect(containsInviteOrMaskedLink(text)).toBe(true);
  });

  it.each([
    "Book the room",
    "https://forms.example/sign-up",
    "www.example.org",
    "Print 2.5 pages",
    "Call them at 10:30",
    "Budget (draft) [v2]",
    "[v2] (draft)",
    "a/b and either/or",
    "discord server rules",
    "discord.com/channels/1/2",
  ])("leaves %s alone", (text) => {
    expect(containsInviteOrMaskedLink(text)).toBe(false);
  });

  it(
    "stays quick on a long hostile value",
    () => {
      const started = performance.now();
      containsInviteOrMaskedLink("discord.".repeat(50_000));
      containsInviteOrMaskedLink("]".repeat(400_000));
      expect(performance.now() - started).toBeLessThan(HOSTILE_INPUT_LIMIT_MS);
    },
    HOSTILE_INPUT_TEST_TIMEOUT_MS,
  );

  it("leaves a plain URL as inert text once escaped", () => {
    const rendered = render("Sign up at https://forms.example/a.b");
    expect(rendered.replace(/\\[\s\S]/gu, "")).not.toContain("://");
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
  });

  it("refuses being called as a function", () => {
    const hostile = ["@everyone"] as unknown as TemplateStringsArray;

    expect(() => safe(hostile)).toThrow(SafeTextError);
  });

  it("refuses a plain string in place of SafeText", () => {
    // @ts-expect-error A plain string is not SafeText.
    expect(() => safeTextValue("@everyone")).toThrow();
    // @ts-expect-error A label is not message text.
    expect(() => safeTextValue(plain`Label`)).toThrow(SafeTextError);
  });

  it("cannot be forged through the constructor", () => {
    const Forge = escapeUserText("x").constructor as new (
      ...args: unknown[]
    ) => SafeText;
    class Forged extends Forge {}

    expect(() => new Forge("@everyone")).toThrow(SafeTextError);
    expect(() => new Forge(Symbol("SafeText"), "@everyone")).toThrow(
      SafeTextError,
    );
    expect(() => new Forged("@everyone")).toThrow(SafeTextError);
    expect(() =>
      Reflect.construct(Forge, [Symbol("SafeText"), "x"], Forged),
    ).toThrow(SafeTextError);
  });

  it("does not show its value through JSON or string conversion", () => {
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
    expect(() => roleMention(`${ID}><@1`)).toThrow(SafeTextError);
    expect(() => userMention("everyone")).toThrow(SafeTextError);
    expect(() => userMention(`${ID}><@&1`)).toThrow(SafeTextError);
    expect(() => channelMention("1")).toThrow(SafeTextError);
  });

  it("accepts a link to a message", () => {
    const url = `https://discord.com/channels/${ID}/${ID}/${ID}`;

    expect(safeTextValue(jumpLink(url))).toBe(url);
  });

  it.each([
    "https://evil.example/channels/1/2/3",
    "https://discord.com.evil.example/channels/1/2/3",
    "https://discord.com/channels/1/2/3 [x](https://evil.example)",
    "https://discord.com/channels/1/2/3\nmore",
    "https://discord.com/invite/abc",
  ])("refuses %j as a link", (url) => {
    expect(() => jumpLink(url)).toThrow(SafeTextError);
  });
});

describe("plainLabel", () => {
  const label = (raw: string, max?: number) =>
    plainTextValue(plainLabel(raw, max));

  it.each([
    ["@everyone meeting", "everyone meeting"],
    ["line\none", "line one"],
    ["\u{202E}gnp.exe", "gnp exe"],
    ["https://evil.example/x", "https evil example x"],
    ["discord.gg/abc", "discord gg abc"],
    [`<@&${ID}> call`, `&${ID} call`],
    ["**bold** `code`", "bold code"],
    ["System: reset", "System reset"],
    ["Spring Mixer - Week 3 (Fri)", "Spring Mixer - Week 3 (Fri)"],
    ["Rock & Roll!", "Rock & Roll!"],
    ["Café Nuit", "Café Nuit"],
    ["\u{1F389} Party", "\u{1F389} Party"],
  ])("makes %j into %j", (raw, expected) => {
    expect(label(raw)).toBe(expected);
  });

  it.each(["", "@@@", "<>", "---", "\u{200B}", "\u{3164}", "()"])(
    "refuses %j, which leaves nothing usable",
    (raw) => {
      expect(() => plainLabel(raw)).toThrow(SafeTextError);
    },
  );

  it("measures the length after normalising", () => {
    expect(label(`${"x".repeat(100)}@@@`)).toHaveLength(100);
    expect(() => plainLabel("x".repeat(101))).toThrow(SafeTextError);
    expect(() => label("\u{1F389}".repeat(51))).toThrow(SafeTextError);
    expect(label("\u{1F389}".repeat(50))).toHaveLength(100);
  });

  it("refuses a plain string where a label is needed", () => {
    // @ts-expect-error A plain string is not a label.
    expect(() => plainTextValue("@everyone")).toThrow();
  });
});

describe("the length validator", () => {
  it("counts an astral character as two", () => {
    expect(textLength("\u{1F600}")).toBe(2);
    expect(textLength("é")).toBe(1);
  });

  it("is never looser than counting code points, as the database does", () => {
    for (const text of ["abc", "\u{1F600}\u{1F600}", "a\u{1F600}b", "é"]) {
      expect(textLength(text)).toBeGreaterThanOrEqual(Array.from(text).length);
    }
  });

  it.each([
    ["x".repeat(100), 100, true],
    ["x".repeat(101), 100, false],
    ["\u{1F600}".repeat(50), 100, true],
    ["\u{1F600}".repeat(50) + "x", 100, false],
    // 100 code points, which a char_length rule would accept.
    ["\u{1F600}".repeat(100), 100, false],
  ])("checks boundary %#", (text, limit, expected) => {
    expect(isWithinLimit(text, limit)).toBe(expected);
  });
});

describe("chunkMessages", () => {
  const line = (text: SafeText, mentionUserIds: readonly string[] = []) => ({
    text,
    mentionUserIds,
  });
  const contents = (chunks: ReturnType<typeof chunkMessages>) =>
    chunks.map((chunk) => safeTextValue(chunk.content));

  it("keeps lines that fit together in one message", () => {
    const chunks = chunkMessages([
      line(escapeUserText("one")),
      line(escapeUserText("two")),
    ]);

    expect(contents(chunks)).toEqual(["one\ntwo"]);
  });

  it("moves a line to the next message rather than splitting it", () => {
    const chunks = chunkMessages(
      [line(escapeUserText("aaaa")), line(escapeUserText("bbbb"))],
      { maxLength: 6 },
    );

    expect(contents(chunks)).toEqual(["aaaa", "bbbb"]);
  });

  it("sends everything for three long descriptions, under the limit", () => {
    const descriptions = ["a", "b", "c"].map((letter) =>
      line(escapeUserText(letter.repeat(999))),
    );

    const chunks = contents(chunkMessages(descriptions));

    expect(chunks).toHaveLength(2);
    expect(chunks.every((text) => text.length <= 2000)).toBe(true);
    expect(chunks.join("\n")).toBe(
      ["a", "b", "c"].map((letter) => letter.repeat(999)).join("\n"),
    );
  });

  it("splits a long line at a space", () => {
    const chunks = chunkMessages([line(escapeUserText("aaaa bbbb cccc"))], {
      maxLength: 10,
    });

    expect(contents(chunks)).toEqual(["aaaa bbbb", "cccc"]);
  });

  it("splits at a space only in the second half of a message", () => {
    const line = escapeUserText(`short ${"x".repeat(150)}`);
    const pieces = chunkMessages([{ text: line, mentionUserIds: [] }], {
      maxLength: 100,
    }).map((chunk) => safeTextValue(chunk.content));
    expect(pieces[0]?.length).toBeGreaterThan(50);
    expect(pieces.join("").replaceAll(" ", "")).toBe(`short${"x".repeat(150)}`);
  });

  it("uses a space late in the message", () => {
    const line = escapeUserText(`${"a".repeat(80)} ${"b".repeat(80)}`);
    const pieces = chunkMessages([{ text: line, mentionUserIds: [] }], {
      maxLength: 100,
    }).map((chunk) => safeTextValue(chunk.content));
    expect(pieces).toEqual(["a".repeat(80), "b".repeat(80)]);
  });

  it("never splits a mention", () => {
    const mention = userMention(ID);
    const text = safe`${escapeUserText("x".repeat(5))}${mention}${mention}${mention}`;

    const chunks = contents(
      chunkMessages([line(text, [ID])], { maxLength: 30 }),
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.replace(new RegExp(`<@${ID}>`, "g"), "")).toMatch(/^x*$/);
    }
  });

  it("never splits an escape", () => {
    const chunks = contents(
      chunkMessages([line(escapeUserText("@".repeat(20)))], { maxLength: 7 }),
    );

    expect(chunks.join("")).toBe(String.raw`\@`.repeat(20));
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^(\\@)+$/);
    }
  });

  it("never splits a surrogate pair or an emoji sequence", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    const emoji = "\u{1F600}";

    const families = contents(
      chunkMessages([line(escapeUserText(family.repeat(5)))], {
        maxLength: 9,
      }),
    );
    const faces = contents(
      chunkMessages([line(escapeUserText(emoji.repeat(5)))], { maxLength: 3 }),
    );

    expect(families).toEqual(Array.from({ length: 5 }, () => family));
    expect(faces).toEqual(Array.from({ length: 5 }, () => emoji));
  });

  it("never splits a link", () => {
    const url = `https://discord.com/channels/${ID}/${ID}/${ID}`;
    const text = safe`${escapeUserText("abc")} ${jumpLink(url)}`;

    const chunks = contents(chunkMessages([line(text)], { maxLength: 85 }));

    expect(chunks).toEqual(["abc", url]);
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

  it("splits one line at the mention limit, even when the length fits", () => {
    const ids = Array.from({ length: 25 }, (_, index) => fakeId(index));
    const text = ids.reduce(
      (joined, id) => safe`${joined} ${userMention(id)}`,
      escapeUserText("Due"),
    );

    const chunks = chunkMessages([line(text, ids)], { maxMentions: 10 });

    expect(chunks.map((chunk) => chunk.mentionUserIds.length)).toEqual([
      10, 10, 5,
    ]);
  });

  it("stays within the mention limit across lines", () => {
    const ids = Array.from({ length: 15 }, (_, index) => fakeId(index));
    const lines = ids.map((id) => line(userMention(id), [id]));

    const chunks = chunkMessages(lines, { maxMentions: 10 });

    expect(chunks.map((chunk) => chunk.mentionUserIds.length)).toEqual([10, 5]);
  });

  it("lists a user only on the chunk that shows them", () => {
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
  });

  it("does not ping a user who is shown but not named", () => {
    const chunks = chunkMessages([line(safe`${userMention(ID)}`, [])]);

    expect(chunks[0]?.mentionUserIds).toEqual([]);
  });

  it("does not ping a user who is named but not shown", () => {
    const chunks = chunkMessages([line(safe`nobody`, [ID])]);

    expect(chunks[0]?.mentionUserIds).toEqual([]);
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
      expected: readonly (readonly [string, readonly string[]])[];
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
        name: "oversized first",
        lines: [said(A, xs(20)), said(B, "two")],
        maxLength: 30,
        expected: [
          [shown(A), [A]],
          [xs(20), []],
          [`${shown(B)} two`, [B]],
        ],
      },
      {
        name: "oversized last",
        lines: [said(A, "one"), said(B, xs(20))],
        maxLength: 30,
        expected: [
          [`${shown(A)} one`, [A]],
          [shown(B), [B]],
          [xs(20), []],
        ],
      },
      {
        name: "two oversized in a row",
        lines: [said(A, xs(20)), said(B, xs(21))],
        maxLength: 30,
        expected: [
          [shown(A), [A]],
          [xs(20), []],
          [shown(B), [B]],
          [xs(21), []],
        ],
      },
      {
        name: "packed short lines on both sides",
        lines: [
          line(safe`one`),
          line(safe`two`),
          said(A, xs(20)),
          line(safe`three`),
          line(safe`four`),
        ],
        maxLength: 30,
        expected: [
          ["one\ntwo", []],
          [shown(A), [A]],
          [xs(20), []],
          ["three\nfour", []],
        ],
      },
      {
        name: "a word and a mention that do not fit together after the cut",
        lines: [
          line(
            safe`${escapeUserText(`${xs(19)} ${"b".repeat(10)}`)}${userMention(A)}`,
            [A],
          ),
        ],
        maxLength: 30,
        expected: [
          [xs(19), []],
          ["b".repeat(10), []],
          [shown(A), [A]],
        ],
      },
      {
        name: "short lines that fill the limit exactly, joined by their newline",
        lines: [
          line(escapeUserText(xs(14))),
          line(escapeUserText("b".repeat(15))),
        ],
        maxLength: 30,
        expected: [[`${xs(14)}\n${"b".repeat(15)}`, []]],
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

  it("makes no message from no lines", () => {
    expect(chunkMessages([])).toEqual([]);
  });

  it("refuses when a single atom cannot fit", () => {
    expect(() =>
      chunkMessages([line(userMention(ID))], { maxLength: 5 }),
    ).toThrow(SafeTextError);
  });
});
