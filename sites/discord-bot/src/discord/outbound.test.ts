import { describe, expect, it } from "bun:test";
import {
  actionRow,
  autocompleteResult,
  button,
  channelMessage,
  deferredEphemeralReply,
  deferredReply,
  deferredUpdate,
  ephemeralReply,
  followUp,
  interactionReply,
  isEphemeralInitialResponse,
  messageEdit,
  modal,
  OutboundBodyError,
  pong,
  roleSelect,
  serializeDirectResponse,
  stringSelect,
  textInputRow,
  threadCreate,
  updateMessage,
} from "./outbound.ts";
import type { MessageInput, OutboundBody, OutboundKind } from "./outbound.ts";
import {
  chunkMessages,
  containsInviteOrMaskedLink,
  discordTimestamp,
  escapeUserText,
  jumpLink,
  plain,
  plainLabel,
  plainTextValue,
  roleMention,
  safe,
  SafeTextError,
  safeTextValue,
  textLength,
  truncateUserText,
  userMention,
} from "./safe-text.ts";
import type { SafeText } from "./safe-text.ts";
import { expectInert } from "../../test/support/discord-server.ts";
import { HOSTILE_TEXT } from "../../test/support/hostile-text.ts";
import { fakeId } from "../../test/support/ids.ts";

const ID = fakeId(1);
const OTHER_USER = fakeId(2);
const ROLE = fakeId(3);
const GUILD = fakeId(4);

/** Every input here must come out inert, as message text and as a label. */
const HOSTILE: readonly (readonly [string, string])[] = [
  ...HOSTILE_TEXT,
  ["markdown", "**bold** *it* __under__ ~~gone~~ `code`"],
  ["escaped backslash", "\\\\<@1>"],
  ["lone surrogate", "\uD800lone"],
];

// The hostile inputs are large enough that linear work ends well inside this limit.
const HOSTILE_INPUT_LIMIT_MS = 15_000;

/** A character that could start syntax in a label, which Discord shows literally. */
const LIVE_IN_LABEL = /[<>@*_~`|#[\]\\:/.\p{Cc}\p{Cf}]/u;

const render = (raw: string) => safeTextValue(escapeUserText(raw));

/** Whatever is left once escaped pairs are removed has no syntax in it. */
function hasLiveSyntax(text: string): boolean {
  const unescaped = text.replace(/\\[\s\S]/gu, "");
  return /[<>@*_~`|#[\]()\\:/\p{Cc}\p{Cf}]/u.test(unescaped);
}

type Wire = Record<string, unknown>;

function wire(body: OutboundBody<OutboundKind>): Wire {
  return JSON.parse(JSON.stringify(body.payload)) as Wire;
}

/** Each message builder, where its message fields sit, and the flags it sets. */
const BUILDERS: readonly (readonly [
  string,
  (input: MessageInput) => OutboundBody<OutboundKind>,
  (body: Wire) => Wire,
  number,
])[] = [
  ["channelMessage", channelMessage, (body) => body, 4],
  ["messageEdit", messageEdit, (body) => body, 4],
  ["interactionReply", interactionReply, (body) => body.data as Wire, 4],
  ["ephemeralReply", ephemeralReply, (body) => body.data as Wire, 68],
  ["updateMessage", updateMessage, (body) => body.data as Wire, 4],
  [
    "ephemeral followUp",
    (input) => followUp({ ...input, ephemeral: true }),
    (body) => body,
    68,
  ],
  [
    "threadCreate",
    (input) => threadCreate({ ...input, name: plain`Event` }),
    (body) => body.message as Wire,
    4,
  ],
];

/** Every place Discord shows a label literally. */
const LABEL_PLACES: readonly ((
  name: ReturnType<typeof plainLabel>,
) => OutboundBody<OutboundKind>)[] = [
  (name) => threadCreate({ name, content: safe`hi`, mentionUserIds: [] }),
  (name) =>
    channelMessage({
      content: safe`hi`,
      mentionUserIds: [],
      components: [
        actionRow(button({ customId: "a", label: name })),
        actionRow(
          stringSelect({
            customId: "a",
            options: [{ label: name, value: "a" }],
          }),
        ),
      ],
    }),
  (name) => autocompleteResult([{ name, value: "a" }]),
  (name) =>
    modal({
      customId: "m",
      title: name,
      rows: [textInputRow({ customId: "t", label: name })],
    }),
];

describe("hostile text", () => {
  it.each(HOSTILE)("leaves nothing live from %s", (_label, raw) => {
    expect(hasLiveSyntax(render(raw))).toBe(false);

    for (const [, build, message] of BUILDERS) {
      const body = build({ content: escapeUserText(raw), mentionUserIds: [] });
      const fields = message(wire(body));
      expect(hasLiveSyntax(fields.content as string)).toBe(false);
      expect(fields.allowed_mentions).toEqual({ parse: [], users: [] });
      expectInert(JSON.stringify(body.payload));
    }

    const label = plainLabel(raw.slice(0, 40), 45);
    expect(plainTextValue(label)).not.toMatch(LIVE_IN_LABEL);
    for (const place of LABEL_PLACES) {
      const json = JSON.stringify(place(label).payload);
      for (const [, text = ""] of json.matchAll(
        /"(?:name|label|title)":"([^"]*)"/g,
      )) {
        expect(text).not.toMatch(LIVE_IN_LABEL);
      }
    }
  });

  it.each([
    ["@everyone", String.raw`\@everyone`],
    ["-# small", String.raw`\-\# small`],
    ["1. one", String.raw`1\. one`],
    ["[a](https://b.c)", String.raw`\[a\]\(https\:\/\/b\.c\)`],
    ["<t:1793745000:t>", String.raw`\<t\:1793745000\:t\>`],
  ])("escapes %j as %j", (raw, expected) => {
    expect(render(raw)).toBe(expected);
  });

  it("leaves ordinary text alone, and drops stray joiners and line breaks", () => {
    expect(render("Bring snacks, please! Is 5 ok?")).toBe(
      "Bring snacks, please! Is 5 ok?",
    );
    expect(render("a\n\n b\r\nc\u{2028}d\u{200D}e\u{34F}f")).toBe("a b c def");
  });

  it.each(["", "\u{200B}\u{FEFF}", "\u{3164}", "\uD800"])(
    "refuses %j, which has nothing visible",
    (raw) => {
      expect(() => escapeUserText(raw)).toThrow(SafeTextError);
      expect(() => plainLabel(raw)).toThrow(SafeTextError);
    },
  );

  it("measures length after cleaning, and truncates without splitting", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

    expect(() =>
      escapeUserText(`${"x".repeat(2000)}${"\u{200B}".repeat(50)}`),
    ).not.toThrow();
    expect(() => escapeUserText("private".repeat(400))).toThrow(
      /^Text is 2800 long, the limit is 2000$/,
    );
    expect(safeTextValue(truncateUserText("@".repeat(100), 11))).toBe(
      `${String.raw`\@`.repeat(5)}…`,
    );
    expect(safeTextValue(truncateUserText(family.repeat(3), 20))).toBe(
      `${family}${family}…`,
    );
    expect(() => truncateUserText("@@@", 2)).toThrow(SafeTextError);
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
    2 * HOSTILE_INPUT_LIMIT_MS,
  );
});

describe("containsInviteOrMaskedLink", () => {
  it.each([
    ["DISCORD.GG/abc", true],
    ["discord.com/invite/abc", true],
    ["[Portal login](https://evil.example)", true],
    ["discord.\u{200B}gg/abc", true],
    ["[log in]\u{34F}(evil)", true],
    ["https://forms.example/sign-up", false],
    ["Budget (draft) [v2]", false],
    ["discord.com/channels/1/2", false],
  ])("reads %j as %p", (text, expected) => {
    expect(containsInviteOrMaskedLink(text)).toBe(expected);
  });
});

describe("the safe tag and mentions", () => {
  it("joins source text with SafeText, and cannot be fed or forged a string", () => {
    const hostile = "@everyone";
    const text = escapeUserText("visible");
    const Forge = text.constructor as new (...args: unknown[]) => SafeText;

    expect(
      safeTextValue(safe`Due: ${escapeUserText("a*b")} for ${userMention(ID)}`),
    ).toBe(String.raw`Due: a\*b for <@` + ID + ">");
    // @ts-expect-error A plain string must not reach message text.
    expect(() => safe`Due: ${hostile}`).toThrow(SafeTextError);
    // @ts-expect-error A label is not message text.
    expect(() => safeTextValue(plain`Label`)).toThrow(SafeTextError);
    expect(() => new Forge(Symbol("SafeText"), hostile)).toThrow(SafeTextError);
    expect(JSON.stringify(text)).toBe("{}");
  });

  it("renders a mention or a jump link only from a valid ID", () => {
    const url = `https://discord.com/channels/${ID}/${ID}/${ID}`;

    expect(safeTextValue(roleMention(ID))).toBe(`<@&${ID}>`);
    expect(() => roleMention("everyone")).toThrow(SafeTextError);
    expect(() => userMention(`${ID}><@&1`)).toThrow(SafeTextError);
    expect(safeTextValue(jumpLink(url))).toBe(url);
    expect(() =>
      jumpLink("https://discord.com.evil.example/channels/1/2/3"),
    ).toThrow(SafeTextError);
    expect(() => jumpLink("https://discord.com/invite/abc")).toThrow(
      SafeTextError,
    );
  });
});

describe("discordTimestamp", () => {
  const instant = Date.UTC(2026, 10, 3, 22, 30);

  it("builds the tag in whole seconds, and refuses a bad instant or style", () => {
    expect(safeTextValue(discordTimestamp(instant + 999, "R"))).toBe(
      `<t:${String(instant / 1000)}:R>`,
    );
    expect(() => discordTimestamp(Number.NaN, "t")).toThrow(SafeTextError);
    expect(() => discordTimestamp(1e30, "t")).toThrow(SafeTextError);
    expect(() =>
      discordTimestamp(instant, "x>" as Parameters<typeof discordTimestamp>[1]),
    ).toThrow(SafeTextError);
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

  it("never splits a mention, and neutralises a continuation's line start", () => {
    const mention = userMention(ID);
    const mentions = chunkMessages(
      [line(safe`${escapeUserText("xxxxx")}${mention}${mention}`, [ID])],
      { maxLength: 30 },
    ).map((chunk) => safeTextValue(chunk.content));
    const heading = chunkMessages(
      [line(safe`${escapeUserText("a".repeat(12))} # title`)],
      { maxLength: 12 },
    ).map((chunk) => safeTextValue(chunk.content));

    for (const chunk of mentions) {
      expect(chunk.replace(new RegExp(`<@${ID}>`, "g"), "")).toMatch(/^x*$/);
    }
    expect(heading).toEqual(["a".repeat(12), String.raw`\# title`]);
  });

  it("pings only users who are named and shown, within the mention limit", () => {
    const ids = Array.from({ length: 250 }, (_, index) => fakeId(index));
    const text = ids.reduce(
      (joined, id) => safe`${joined} ${userMention(id)}`,
      escapeUserText("Due"),
    );
    const chunks = chunkMessages([line(text, ids)]);

    for (const chunk of chunks) {
      const shown = safeTextValue(chunk.content).match(/<@[0-9]+>/g) ?? [];
      expect(chunk.mentionUserIds.length).toBeLessThanOrEqual(100);
      expect(textLength(safeTextValue(chunk.content))).toBeLessThanOrEqual(
        2000,
      );
      expect(shown).toHaveLength(chunk.mentionUserIds.length);
    }
    expect(chunks.flatMap((chunk) => chunk.mentionUserIds).sort()).toEqual(
      [...ids].sort(),
    );
    expect(
      chunkMessages([line(safe`${userMention(ID)}`, [])])[0]?.mentionUserIds,
    ).toEqual([]);
    expect(
      chunkMessages([line(safe`nobody`, [ID])])[0]?.mentionUserIds,
    ).toEqual([]);
  });
});

describe("message bodies", () => {
  it.each(BUILDERS)(
    "%s pings only named users and roles, with its own flags",
    (_name, build, message, flags) => {
      const input = {
        content: safe`${userMention(ID)} ${userMention(OTHER_USER)} ${roleMention(ROLE)} ${escapeUserText("@everyone")}`,
        mentionUserIds: [ID, ID],
        mentionRoleIds: [ROLE, ROLE],
        roleGuildId: GUILD,
        allowed_mentions: { parse: ["everyone", "roles", "users"] },
        flags: 0,
        embeds: [{ description: "@everyone" }],
      };

      const fields = message(wire(build(input)));

      expect(fields.allowed_mentions).toEqual({
        parse: [],
        users: [ID],
        roles: [ROLE],
      });
      expect(fields.flags).toBe(flags);
      expect(fields.embeds).toBeUndefined();
    },
  );

  const build = (input: Partial<MessageInput>) => () =>
    channelMessage({ content: safe`hi`, mentionUserIds: [], ...input });

  it("refuses @everyone as a role, bad mentions, and plain or long text", () => {
    const ids = Array.from({ length: 101 }, (_, index) => fakeId(index));

    expect(build({ mentionRoleIds: [GUILD], roleGuildId: GUILD })).toThrow(
      /^A message cannot mention @everyone$/,
    );
    expect(build({ mentionUserIds: ["everyone"] })).toThrow(
      /^Every mentioned user must be a Discord ID$/,
    );
    expect(build({ mentionRoleIds: [ROLE] })).toThrow(
      /^A role mention needs the guild it belongs to$/,
    );
    expect(build({ mentionUserIds: ids })).toThrow(OutboundBodyError);
    // @ts-expect-error A plain string must not reach message text.
    expect(build({ content: "@everyone" })).toThrow();
    expect(build({ content: escapeUserText("@".repeat(1001)) })).toThrow(
      /^Message content must be 1 to 2000 characters, got 2002$/,
    );
  });
});

describe("interaction responses", () => {
  const text = { content: safe`hi`, mentionUserIds: [] };

  it("send only silent bodies directly, and keep a public reply public", () => {
    const reply = wire(interactionReply({ ...text, ephemeral: true } as never));

    expect(wire(deferredEphemeralReply())).toEqual({
      type: 5,
      data: { flags: 64 },
    });
    expect((reply.data as Wire).flags).toBe(4);
    expect(isEphemeralInitialResponse(ephemeralReply(text))).toBe(true);
    expect(isEphemeralInitialResponse(deferredReply())).toBe(false);
    expect(JSON.parse(serializeDirectResponse(pong()))).toEqual({ type: 1 });
    expect(JSON.parse(serializeDirectResponse(deferredUpdate()))).toEqual({
      type: 6,
    });
    for (const body of [
      deferredReply(),
      updateMessage(text),
      followUp({ ...text, ephemeral: true }),
      { ...deferredReply(), kind: "direct-response" as const },
    ]) {
      expect(() => serializeDirectResponse(body as never)).toThrow(
        OutboundBodyError,
      );
    }
    // @ts-expect-error A public reply needs the managed check.
    expect(() => serializeDirectResponse(interactionReply(text))).toThrow(
      OutboundBodyError,
    );
  });
});

describe("components and modals", () => {
  const press = (customId: string) => button({ customId, label: plain`Press` });
  const components = (...rows: ReturnType<typeof actionRow>[]) =>
    wire(
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: rows,
      }),
    ).components;

  it("builds a button", () => {
    const done = button({ customId: "task:done", label: plain`Done` });

    expect(components(actionRow(done))).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: "task:done",
            label: "Done",
            disabled: false,
          },
        ],
      },
    ]);
  });

  it("refuses bad custom IDs, full rows, an empty modal and a link button", () => {
    const five = Array.from({ length: 5 }, (_, index) => press(String(index)));
    const select = roleSelect({ customId: "role" });
    const link = button({
      customId: "a",
      label: plain`A`,
      url: "https://evil.example",
    } as never);

    for (const customId of ["a b", "a\u{200B}b", "x".repeat(101)]) {
      expect(() => press(customId)).toThrow(OutboundBodyError);
    }
    expect(() => actionRow(...five, press("6"))).toThrow(OutboundBodyError);
    expect(() =>
      actionRow(...([select, press("a")] as never as [typeof select])),
    ).toThrow(OutboundBodyError);
    expect(() =>
      components(...Array.from({ length: 6 }, () => actionRow(press("a")))),
    ).toThrow(OutboundBodyError);
    expect(() =>
      modal({ customId: "m", title: plain`Title`, rows: [] }),
    ).toThrow(OutboundBodyError);
    expect(JSON.stringify(components(actionRow(link)))).not.toContain("evil");
  });
});
