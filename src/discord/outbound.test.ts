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
  isSilentResponse,
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
  escapeUserText,
  plain,
  plainLabel,
  roleMention,
  safe,
  userMention,
} from "./safe-text.ts";
import { expectInert, liveText } from "../../test/support/discord-server.ts";
import { fakeId } from "../../test/support/ids.ts";

const NAMED_USER = fakeId(1);
const OTHER_USER = fakeId(2);
const ROLE = fakeId(3);
const GUILD = fakeId(4);
const OTHER_ROLE = fakeId(5);

const HOSTILE_CORPUS = [
  `@everyone <@&${ROLE}> <@${OTHER_USER}>`,
  "**System:** ||hidden|| `code`\n# Header\n> quote",
  "[Log in](https://evil.example) discord.gg/abcd",
  "\u{202E}gnp.exe a\u{200B}b tag\u{E0041}",
];

const HOSTILE_LABELS = [
  "@everyone <@&1> <#2>",
  "**System:** ||hidden|| `code`",
  "[Log in](https://evil.example)",
  "\u{202E}gnp.exe a\u{200B}b",
];

type Wire = Record<string, unknown>;

function wire(body: OutboundBody<OutboundKind>): Wire {
  return JSON.parse(JSON.stringify(body.payload)) as Wire;
}

function hasLiveSyntax(text: string): boolean {
  const unescaped = text.replace(/\\[\s\S]/gu, "");
  return /[<>@*_~`|#[\]()\\:/\p{Cc}\p{Cf}]/u.test(unescaped);
}

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
  ["followUp", followUp, (body) => body, 4],
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

describe.each(BUILDERS)("%s", (_name, build, message, flags) => {
  it("renders hostile text inert", () => {
    for (const raw of HOSTILE_CORPUS) {
      const body = build({ content: escapeUserText(raw), mentionUserIds: [] });
      const fields = message(wire(body));

      expect(hasLiveSyntax(fields.content as string)).toBe(false);
      expect(fields.allowed_mentions).toEqual({ parse: [], users: [] });
      expectInert(JSON.stringify(body.payload));
    }
  });

  it("pings only the named users, whatever the text mentions", () => {
    const hostile = escapeUserText(HOSTILE_CORPUS.join(" "));
    const content = safe`${userMention(NAMED_USER)} ${userMention(OTHER_USER)} ${hostile}`;

    const fields = message(
      wire(build({ content, mentionUserIds: [NAMED_USER, NAMED_USER] })),
    );

    expect(fields.allowed_mentions).toEqual({
      parse: [],
      users: [NAMED_USER],
    });
  });

  it("suppresses embeds and does not carry over fields from its input", () => {
    const input = {
      content: safe`hello`,
      mentionUserIds: [],
      allowed_mentions: { parse: ["everyone", "roles", "users"] },
      flags: 0,
      embeds: [{ description: "@everyone" }],
    };

    const fields = message(wire(build(input)));

    expect(fields.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(fields.flags).toBe(flags);
    expect(fields.embeds).toBeUndefined();
  });

  it("pings only the named roles, and no role the text merely shows", () => {
    const content = safe`${roleMention(ROLE)} ${roleMention(OTHER_ROLE)} done`;

    const fields = message(
      wire(
        build({
          content,
          mentionUserIds: [NAMED_USER],
          mentionRoleIds: [ROLE, ROLE],
          roleGuildId: GUILD,
        }),
      ),
    );

    expect(fields.allowed_mentions).toEqual({
      parse: [],
      users: [NAMED_USER],
      roles: [ROLE],
    });
  });

  it("refuses the guild's own ID as a role, since that is @everyone", () => {
    expect(() =>
      build({
        content: safe`hi`,
        mentionUserIds: [],
        mentionRoleIds: [ROLE, GUILD],
        roleGuildId: GUILD,
      }),
    ).toThrow(/^A message cannot mention @everyone$/);
  });
});

describe("mention and content checks", () => {
  const build = (input: Partial<MessageInput>) => () =>
    channelMessage({ content: safe`hi`, mentionUserIds: [], ...input });
  const roles = (mentionRoleIds: string[], roleGuildId?: string) =>
    build({ mentionRoleIds, ...(roleGuildId ? { roleGuildId } : {}) });

  it("refuses a malformed user or role without repeating it", () => {
    for (const id of ["everyone", "123", `<@${NAMED_USER}>`]) {
      expect(build({ mentionUserIds: [id] })).toThrow(
        /^Every mentioned user must be a Discord ID$/,
      );
    }
    expect(roles([`<@&${ROLE}>`], GUILD)).toThrow(
      /^Every mentioned role must be a Discord ID$/,
    );
    expect(roles([ROLE])).toThrow(
      /^A role mention needs the guild it belongs to$/,
    );
  });

  it("refuses more than 100 mentioned users", () => {
    const ids = Array.from({ length: 101 }, (_, index) => fakeId(index));

    expect(build({ mentionUserIds: ids })).toThrow(OutboundBodyError);
    expect(build({ mentionUserIds: ids.slice(0, 100) })).not.toThrow();
  });

  it("refuses a plain string, and text that escaping took over the limit", () => {
    // @ts-expect-error A plain string must not reach message text.
    expect(build({ content: "@everyone" })).toThrow();
    expect(build({ content: escapeUserText("@".repeat(1001)) })).toThrow(
      /^Message content must be 1 to 2000 characters, got 2002$/,
    );
    expect(build({ content: escapeUserText("x".repeat(2000)) })).not.toThrow();
  });
});

describe("interaction responses", () => {
  const text = { content: safe`hi`, mentionUserIds: [] };

  it("have the right shapes, and a public reply cannot become ephemeral", () => {
    const reply = wire(interactionReply({ ...text, ephemeral: true } as never));

    expect(wire(deferredEphemeralReply())).toEqual({
      type: 5,
      data: { flags: 64 },
    });
    expect(wire(deferredUpdate())).toEqual({ type: 6 });
    expect(wire(updateMessage(text)).type).toBe(7);
    expect(reply.type).toBe(4);
    expect((reply.data as Wire).flags).toBe(4);
  });

  it("isEphemeralInitialResponse accepts only flagged first responses", () => {
    expect(isEphemeralInitialResponse(ephemeralReply(text))).toBe(true);
    expect(isEphemeralInitialResponse(deferredEphemeralReply())).toBe(true);
    expect(isEphemeralInitialResponse(interactionReply(text))).toBe(false);
    expect(isEphemeralInitialResponse(deferredReply())).toBe(false);
  });
});

it("the inert check finds live text in a reply and in a text display", () => {
  expect(liveText(JSON.stringify({ content: "\\\\@here" }))).toHaveLength(1);
  expect(
    liveText(
      JSON.stringify({ components: [{ type: 10, content: "[a] (b)" }] }),
    ),
  ).toHaveLength(1);
});

describe("serializeDirectResponse", () => {
  const text = { content: safe`hi`, mentionUserIds: [] };

  it.each([
    ["pong", pong()],
    ["an ephemeral reply", ephemeralReply(text)],
    ["autocomplete results", autocompleteResult([])],
  ])("accepts %s", (_label, body) => {
    expect(isSilentResponse(body)).toBe(true);
    expect(JSON.parse(serializeDirectResponse(body))).toEqual(wire(body));
  });

  it.each([
    ["a public defer", () => deferredReply()],
    ["a message update", () => updateMessage(text)],
    ["an ephemeral follow-up", () => followUp({ ...text, ephemeral: true })],
    ["a channel message", () => channelMessage(text)],
  ])("refuses %s at runtime", (_label, build) => {
    expect(isSilentResponse(build() as never)).toBe(false);
    expect(() => serializeDirectResponse(build() as never)).toThrow(
      OutboundBodyError,
    );
  });

  it("refuses public bodies in the types, and reads the payload, not the kind", () => {
    const relabelled = { ...deferredReply(), kind: "direct-response" as const };

    // @ts-expect-error A public reply needs the managed check.
    expect(() => serializeDirectResponse(interactionReply(text))).toThrow(
      OutboundBodyError,
    );
    expect(() => serializeDirectResponse(relabelled)).toThrow(
      OutboundBodyError,
    );
  });
});

describe("threadCreate", () => {
  it("nests the first message in the thread body", () => {
    const body = wire(
      threadCreate({
        name: plainLabel("@everyone Spring Mixer"),
        content: safe`details`,
        mentionUserIds: [NAMED_USER],
      }),
    );

    expect(body).toEqual({
      name: "everyone Spring Mixer",
      message: {
        content: "details",
        flags: 4,
        allowed_mentions: { parse: [], users: [NAMED_USER] },
      },
    });
  });
});

describe("places Discord shows literally", () => {
  const live = /[<>@*_~`|#[\]\\:/.\p{Cc}\p{Cf}]/u;
  const places: readonly (readonly [
    string,
    (name: ReturnType<typeof plainLabel>) => unknown,
  ])[] = [
    [
      "thread name",
      (name) => threadCreate({ name, content: safe`hi`, mentionUserIds: [] }),
    ],
    [
      "button label and select option",
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
    ],
    [
      "autocomplete choice",
      (name) => autocompleteResult([{ name, value: "a" }]),
    ],
    [
      "modal title",
      (name) =>
        modal({
          customId: "m",
          title: name,
          rows: [textInputRow({ customId: "t", label: name })],
        }),
    ],
  ];

  it.each(places)("leaves nothing live in a %s", (_place, build) => {
    for (const raw of HOSTILE_LABELS) {
      const text = JSON.stringify(build(plainLabel(raw, 45)));

      expect(
        Array.from(text.matchAll(/"(?:name|label|title)":"([^"]*)"/g)).every(
          (match) => !live.test(match[1] ?? ""),
        ),
      ).toBe(true);
    }
  });
});

describe("autocompleteResult", () => {
  it("has the right shape", () => {
    const body = autocompleteResult([
      { name: plainLabel("@everyone Mixer"), value: "event:1" },
    ]);

    expect(wire(body)).toEqual({
      type: 8,
      data: { choices: [{ name: "everyone Mixer", value: "event:1" }] },
    });
  });
});

describe("modal", () => {
  const row = textInputRow({
    customId: "description",
    label: plain`Description`,
    style: "paragraph",
    maxLength: 500,
  });

  it("has the right shape", () => {
    const body = wire(
      modal({ customId: "task:edit", title: plain`Edit task`, rows: [row] }),
    );

    expect(body).toMatchObject({
      type: 9,
      data: { custom_id: "task:edit", title: "Edit task" },
    });
    expect(JSON.stringify(body)).toContain(
      '{"type":4,"custom_id":"description","label":"Description","style":2,"required":true,"max_length":500}',
    );
  });

  it("refuses no rows, more than five, or a title over 45", () => {
    expect(() =>
      modal({ customId: "m", title: plain`Title`, rows: [] }),
    ).toThrow(OutboundBodyError);
    expect(() =>
      modal({
        customId: "m",
        title: plain`Title`,
        rows: Array.from({ length: 6 }, () => row),
      }),
    ).toThrow(OutboundBodyError);
    expect(() =>
      modal({ customId: "m", title: plainLabel("x".repeat(46)), rows: [row] }),
    ).toThrow(OutboundBodyError);
  });
});

describe("components", () => {
  const press = (customId: string) => button({ customId, label: plain`Press` });
  const components = (...rows: ReturnType<typeof actionRow>[]) =>
    wire(
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: rows,
      }),
    ).components;

  it("builds a button and a string select", () => {
    expect(
      components(
        actionRow(
          button({
            customId: "task:done",
            label: plain`Done`,
            style: "danger",
          }),
        ),
        actionRow(
          stringSelect({
            customId: "pick",
            placeholder: plain`Choose`,
            options: [{ label: plainLabel("<@1> option"), value: "one" }],
          }),
        ),
      ),
    ).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            custom_id: "task:done",
            label: "Done",
            disabled: false,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "pick",
            placeholder: "Choose",
            options: [{ label: "1 option", value: "one" }],
          },
        ],
      },
    ]);
  });

  it("refuses a hidden or spaced custom ID, and one over 100", () => {
    for (const customId of ["a b", "a\u{200B}b", "x".repeat(101)]) {
      expect(() => press(customId)).toThrow(OutboundBodyError);
    }
    expect(() => press("x".repeat(100))).not.toThrow();
  });

  it("holds up to five buttons or one select in a row, and five rows", () => {
    const five = Array.from({ length: 5 }, (_, index) => press(String(index)));
    const select = roleSelect({ customId: "role" });

    expect(() => actionRow(...five, press("6"))).toThrow(OutboundBodyError);
    expect(() =>
      actionRow(...([select, press("a")] as never as [typeof select])),
    ).toThrow(OutboundBodyError);
    expect(() =>
      components(...Array.from({ length: 6 }, () => actionRow(press("a")))),
    ).toThrow(OutboundBodyError);
  });

  it("has no way to make a link button", () => {
    const row = actionRow(
      button({
        customId: "a",
        label: plain`A`,
        url: "https://evil.example",
      } as never),
    );

    expect(JSON.stringify(components(row))).not.toContain("evil");
  });
});
