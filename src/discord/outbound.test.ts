import { describe, expect, it } from "vitest";
import {
  actionRow,
  autocompleteResult,
  button,
  channelMessage,
  channelSelect,
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
  serializeOutboundBody,
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
  safe,
  userMention,
} from "./safe-text.ts";

// Built at runtime: the secret scan refuses any literal shaped like a Discord ID.
function fakeId(n: number): string {
  return String(10n ** 17n + BigInt(n));
}

const NAMED_USER = fakeId(1);
const OTHER_USER = fakeId(2);
const ROLE = fakeId(3);

const HOSTILE_CORPUS = [
  "@everyone",
  "@here",
  `<@&${ROLE}>`,
  `<@${OTHER_USER}>`,
  `<@!${OTHER_USER}>`,
  `<#${ROLE}>`,
  `</deploy:${ROLE}>`,
  "<t:1700000000:R>",
  `<a:wave:${ROLE}>`,
  "**System:** ||hidden|| ~~gone~~ `code` ``` fence ```",
  "# Header\n-# small\n> quote\n- item",
  "line one\nSystem: line two",
  "[Portal login required](https://evil.example)",
  "https://evil.example discord.gg/abcd",
  "\u{202E}gnp.exe a\u{200B}b tag\u{E0041}",
];

type Wire = Record<string, unknown>;

function wire(body: OutboundBody<OutboundKind>): Wire {
  return JSON.parse(JSON.stringify(body)) as Wire;
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
  it.each(HOSTILE_CORPUS)("renders %j inert", (raw) => {
    const fields = message(
      wire(build({ content: escapeUserText(raw), mentionUserIds: [] })),
    );

    expect(hasLiveSyntax(fields.content as string)).toBe(false);
    expect(fields.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("pings only the named users, whatever the text mentions", () => {
    const hostile = escapeUserText(HOSTILE_CORPUS.join(" "));
    const content = safe`${userMention(NAMED_USER)} ${userMention(OTHER_USER)} ${hostile}`;

    const fields = message(
      wire(build({ content, mentionUserIds: [NAMED_USER] })),
    );

    expect(fields.allowed_mentions).toEqual({
      parse: [],
      users: [NAMED_USER],
    });
  });

  it("suppresses embeds", () => {
    const fields = message(
      wire(build({ content: safe`hello`, mentionUserIds: [] })),
    );

    expect(fields.flags).toBe(flags);
  });

  it("does not carry over fields from its input", () => {
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

  it("lists a repeated user once", () => {
    const fields = message(
      wire(
        build({
          content: safe`hi`,
          mentionUserIds: [NAMED_USER, NAMED_USER],
        }),
      ),
    );

    expect(fields.allowed_mentions).toEqual({
      parse: [],
      users: [NAMED_USER],
    });
  });

  it.each(["everyone", "@here", "", "123", `<@${NAMED_USER}>`])(
    "refuses %j as a mentioned user without repeating it",
    (id) => {
      const attempt = () => build({ content: safe`hi`, mentionUserIds: [id] });

      expect(attempt).toThrow(OutboundBodyError);
      expect(attempt).toThrow(/^Every mentioned user must be a Discord ID$/);
    },
  );

  it("refuses more than 100 mentioned users", () => {
    const mentionUserIds = Array.from({ length: 101 }, (_, index) =>
      fakeId(index),
    );

    expect(() => build({ content: safe`hi`, mentionUserIds })).toThrow(
      OutboundBodyError,
    );
    expect(() =>
      build({
        content: safe`hi`,
        mentionUserIds: mentionUserIds.slice(0, 100),
      }),
    ).not.toThrow();
  });

  it("refuses a plain string as content", () => {
    expect(() =>
      // @ts-expect-error A plain string must not reach message text.
      build({ content: "@everyone", mentionUserIds: [] }),
    ).toThrow();
  });

  it("refuses text that escaping took over the length limit", () => {
    const content = escapeUserText("@".repeat(1001));

    expect(() => build({ content, mentionUserIds: [] })).toThrow(
      /^Message content must be 1 to 2000 characters, got 2002$/,
    );
  });

  it("accepts content at the length limit", () => {
    expect(() =>
      build({ content: escapeUserText("x".repeat(2000)), mentionUserIds: [] }),
    ).not.toThrow();
  });

  it("carries components", () => {
    const row = actionRow(
      button({ customId: "task:done", label: plain`Mark done` }),
    );

    const fields = message(
      wire(
        build({
          content: safe`hello`,
          mentionUserIds: [],
          components: [row],
        }),
      ),
    );

    expect(fields.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: "task:done",
            label: "Mark done",
            disabled: false,
          },
        ],
      },
    ]);
  });
});

describe("interaction responses", () => {
  const text = { content: safe`hi`, mentionUserIds: [] };

  it.each([
    ["pong", pong(), { type: 1 }],
    ["deferredReply", deferredReply(), { type: 5 }],
    [
      "deferredEphemeralReply",
      deferredEphemeralReply(),
      { type: 5, data: { flags: 64 } },
    ],
    ["deferredUpdate", deferredUpdate(), { type: 6 }],
  ])("%s has the right shape and no text", (_name, body, expected) => {
    expect(wire(body)).toEqual(expected);
  });

  it("interactionReply has no way to become ephemeral", () => {
    const body = wire(interactionReply({ ...text, ephemeral: true } as never));

    expect(body.type).toBe(4);
    expect((body.data as Wire).flags).toBe(4);
  });

  it("uses type 7 for updateMessage", () => {
    expect(wire(updateMessage(text)).type).toBe(7);
  });

  it("isEphemeralInitialResponse accepts only flagged first responses", () => {
    expect(isEphemeralInitialResponse(ephemeralReply(text))).toBe(true);
    expect(isEphemeralInitialResponse(deferredEphemeralReply())).toBe(true);
    expect(isEphemeralInitialResponse(interactionReply(text))).toBe(false);
    expect(isEphemeralInitialResponse(deferredReply())).toBe(false);
    expect(isEphemeralInitialResponse(deferredUpdate())).toBe(false);
    expect(isEphemeralInitialResponse(updateMessage(text))).toBe(false);
    expect(isEphemeralInitialResponse(pong())).toBe(false);
  });

  it("isEphemeralInitialResponse refuses anything not built here", () => {
    const forged = {
      kind: "direct-response" as const,
      type: 4,
      data: { flags: 64 },
      toJSON: () => ({ type: 4, data: { flags: 64 } }),
    };

    // @ts-expect-error A plain object must not be accepted as a body.
    expect(isEphemeralInitialResponse(forged)).toBe(false);
  });

  it("isEphemeralInitialResponse ignores other body kinds", () => {
    const followed = followUp({ ...text, ephemeral: true });

    // @ts-expect-error A follow-up is not a first response.
    expect(isEphemeralInitialResponse(followed)).toBe(false);
  });
});

describe("serializeDirectResponse", () => {
  const text = { content: safe`hi`, mentionUserIds: [] };

  it.each([
    ["pong", pong()],
    ["an ephemeral reply", ephemeralReply(text)],
    ["an ephemeral defer", deferredEphemeralReply()],
    ["a component acknowledgement", deferredUpdate()],
    ["autocomplete results", autocompleteResult([])],
    [
      "a modal",
      modal({
        customId: "m",
        title: plain`Title`,
        rows: [textInputRow({ customId: "t", label: plain`Label` })],
      }),
    ],
  ])("accepts %s", (_label, body) => {
    expect(isSilentResponse(body)).toBe(true);
    expect(JSON.parse(serializeDirectResponse(body))).toEqual(wire(body));
  });

  it.each([
    ["a public reply", () => interactionReply(text)],
    ["a public defer", () => deferredReply()],
    ["a message update", () => updateMessage(text)],
    ["a follow-up", () => followUp(text)],
    ["an ephemeral follow-up", () => followUp({ ...text, ephemeral: true })],
    ["a channel message", () => channelMessage(text)],
    ["a message edit", () => messageEdit(text)],
    ["a thread", () => threadCreate({ ...text, name: plain`Event` })],
  ])("refuses %s at runtime", (_label, build) => {
    expect(isSilentResponse(build() as never)).toBe(false);
    expect(() => serializeDirectResponse(build() as never)).toThrow(
      OutboundBodyError,
    );
  });

  it("refuses public bodies in the types", () => {
    const attempts = [
      // @ts-expect-error A public reply needs the managed check.
      () => serializeDirectResponse(interactionReply(text)),
      // @ts-expect-error A public defer needs the managed check.
      () => serializeDirectResponse(deferredReply()),
      // @ts-expect-error A message update needs the managed check.
      () => serializeDirectResponse(updateMessage(text)),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(OutboundBodyError);
    }
  });

  it("refuses a forged body, whatever it claims", () => {
    const forged = {
      kind: "direct-response" as const,
      toJSON: () => ({ type: 4, data: { flags: 64, content: "@everyone" } }),
    };

    // @ts-expect-error A plain object must not be accepted as a body.
    expect(() => serializeDirectResponse(forged)).toThrow(OutboundBodyError);
  });

  it("does not trust the kind of a public body", () => {
    const body = deferredReply();

    expect(() => {
      (body as { kind: string }).kind = "direct-response";
    }).toThrow(TypeError);
    expect(() => serializeDirectResponse(body as never)).toThrow(
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

  it("refuses a plain string as a name", () => {
    expect(() =>
      threadCreate({
        // @ts-expect-error A thread name must go through plainLabel.
        name: "@everyone",
        content: safe`details`,
        mentionUserIds: [],
      }),
    ).toThrow();
  });
});

describe("places Discord shows literally", () => {
  const live = /[<>@*_~`|#[\]\\:/.\p{Cc}\p{Cf}]/u;
  const row = (name: ReturnType<typeof plainLabel>) =>
    actionRow(button({ customId: "a", label: name }));
  const places: readonly (readonly [
    string,
    (name: ReturnType<typeof plainLabel>) => unknown,
  ])[] = [
    [
      "thread name",
      (name) => threadCreate({ name, content: safe`hi`, mentionUserIds: [] }),
    ],
    [
      "button label",
      (name) =>
        channelMessage({
          content: safe`hi`,
          mentionUserIds: [],
          components: [row(name)],
        }),
    ],
    [
      "select option",
      (name) =>
        channelMessage({
          content: safe`hi`,
          mentionUserIds: [],
          components: [
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

  describe.each(places)("%s", (_place, build) => {
    it.each(HOSTILE_CORPUS)("leaves nothing live from %j", (raw) => {
      const text = JSON.stringify(build(plainLabel(raw, 45)));

      expect(
        Array.from(text.matchAll(/"(?:name|label|title)":"([^"]*)"/g)).every(
          (match) => !live.test(match[1] ?? ""),
        ),
      ).toBe(true);
    });
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

  it("allows an empty list, for someone who may not see any", () => {
    expect(wire(autocompleteResult([]))).toEqual({
      type: 8,
      data: { choices: [] },
    });
  });

  it("refuses more than 25 choices", () => {
    const choices = Array.from({ length: 26 }, (_, index) => ({
      name: plain`Event`,
      value: String(index),
    }));

    expect(() => autocompleteResult(choices)).toThrow(OutboundBodyError);
    expect(() => autocompleteResult(choices.slice(0, 25))).not.toThrow();
  });

  it.each(["", "two words", "x".repeat(101), "a\u{200B}b"])(
    "refuses the value %j",
    (value) => {
      expect(() => autocompleteResult([{ name: plain`Event`, value }])).toThrow(
        OutboundBodyError,
      );
    },
  );
});

describe("modal", () => {
  const row = textInputRow({
    customId: "description",
    label: plain`Description`,
    style: "paragraph",
    maxLength: 500,
  });

  it("has the right shape", () => {
    expect(
      wire(
        modal({ customId: "task:edit", title: plain`Edit task`, rows: [row] }),
      ),
    ).toEqual({
      type: 9,
      data: {
        custom_id: "task:edit",
        title: "Edit task",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "description",
                label: "Description",
                style: 2,
                required: true,
                max_length: 500,
              },
            ],
          },
        ],
      },
    });
  });

  it("refuses no rows or more than five", () => {
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
  });

  it("refuses a title over 45", () => {
    expect(() =>
      modal({
        customId: "m",
        title: plainLabel("x".repeat(46)),
        rows: [row],
      }),
    ).toThrow(OutboundBodyError);
  });
});

describe("components", () => {
  const press = (customId: string) => button({ customId, label: plain`Press` });

  it.each([
    ["primary", 1],
    ["secondary", 2],
    ["success", 3],
    ["danger", 4],
  ] as const)("gives the %s button style %i", (style, number) => {
    const row = actionRow(button({ customId: "a", label: plain`A`, style }));
    const body = wire(
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: [row],
      }),
    ) as { components: { components: { style: number }[] }[] };

    expect(body.components[0]?.components[0]?.style).toBe(number);
  });

  it("refuses a hidden or spaced custom ID, and one over 100", () => {
    for (const customId of ["", "a b", "a\u{200B}b", "x".repeat(101)]) {
      expect(() => press(customId)).toThrow(OutboundBodyError);
    }
    expect(() => press("x".repeat(100))).not.toThrow();
  });

  it("refuses a plain string as a label", () => {
    expect(() =>
      // @ts-expect-error A label must go through plainLabel or plain.
      button({ customId: "a", label: "@everyone" }),
    ).toThrow();
  });

  it("refuses a label over 80", () => {
    expect(() =>
      button({ customId: "a", label: plainLabel("x".repeat(81)) }),
    ).toThrow(OutboundBodyError);
  });

  it("holds up to five buttons in a row", () => {
    const five = Array.from({ length: 5 }, (_, index) => press(String(index)));

    expect(() => actionRow(...five)).not.toThrow();
    expect(() => actionRow(...five, press("6"))).toThrow(OutboundBodyError);
    expect(() => actionRow()).toThrow(OutboundBodyError);
  });

  it("holds a select alone in a row", () => {
    const select = roleSelect({ customId: "role" });

    expect(() => actionRow(select)).not.toThrow();
    expect(() =>
      actionRow(...([select, press("a")] as never as [typeof select])),
    ).toThrow(OutboundBodyError);
  });

  it("builds a string select", () => {
    const row = actionRow(
      stringSelect({
        customId: "pick",
        placeholder: plain`Choose`,
        options: [{ label: plainLabel("<@1> option"), value: "one" }],
      }),
    );
    const body = wire(
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: [row],
      }),
    );

    expect(body.components).toEqual([
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

  it("refuses a select with no options or more than 25", () => {
    const option = { label: plain`One`, value: "one" };

    expect(() => stringSelect({ customId: "p", options: [] })).toThrow(
      OutboundBodyError,
    );
    expect(() =>
      stringSelect({
        customId: "p",
        options: Array.from({ length: 26 }, () => option),
      }),
    ).toThrow(OutboundBodyError);
  });

  it("builds channel and role selects", () => {
    const body = wire(
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: [
          actionRow(channelSelect({ customId: "c", channelTypes: [15, 16] })),
          actionRow(roleSelect({ customId: "r", placeholder: plain`Role` })),
        ],
      }),
    );

    expect(body.components).toEqual([
      {
        type: 1,
        components: [{ type: 8, custom_id: "c", channel_types: [15, 16] }],
      },
      {
        type: 1,
        components: [{ type: 6, custom_id: "r", placeholder: "Role" }],
      },
    ]);
  });

  it("refuses more than five rows on a message", () => {
    const row = actionRow(press("a"));

    expect(() =>
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: Array.from({ length: 6 }, () => row),
      }),
    ).toThrow(OutboundBodyError);
  });

  it("refuses a component not made here", () => {
    const forged = {
      kind: "row" as const,
      toJSON: () => ({ type: 2, style: 5, url: "https://evil.example" }),
    };

    expect(() =>
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        // @ts-expect-error A plain object must not be accepted as a component.
        components: [forged],
      }),
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
    const body = wire(
      channelMessage({
        content: safe`hi`,
        mentionUserIds: [],
        components: [row],
      }),
    );

    expect(JSON.stringify(body)).not.toContain("evil");
  });
});

describe("OutboundBody", () => {
  const safeBody = () =>
    channelMessage({ content: safe`safe`, mentionUserIds: [] });
  const everyone = {
    content: "@everyone",
    allowed_mentions: { parse: ["everyone"] },
  };

  it("cannot be changed through its JSON form", () => {
    const body = safeBody();

    const copy = body.toJSON() as { allowed_mentions: { parse: string[] } };
    copy.allowed_mentions.parse.push("everyone");

    expect(JSON.parse(serializeOutboundBody(body, "channel-message"))).toEqual({
      content: "safe",
      flags: 4,
      allowed_mentions: { parse: [], users: [] },
    });
  });

  it("is not satisfied by a plain object, in the types or at runtime", () => {
    const forged = {
      kind: "channel-message" as const,
      ...everyone,
      toJSON: () => null,
    };

    expect(() =>
      // @ts-expect-error A plain object must not be accepted as a body.
      serializeOutboundBody(forged, "channel-message"),
    ).toThrow(OutboundBodyError);
  });

  it("cannot be forged through body.constructor", () => {
    const Forge = safeBody().constructor as new (
      ...args: unknown[]
    ) => OutboundBody<"channel-message">;

    for (const args of [
      ["channel-message", everyone],
      [Symbol("OutboundBody"), "channel-message", everyone],
      [undefined, "channel-message", everyone],
    ]) {
      expect(() => new Forge(...args)).toThrow(OutboundBodyError);
    }
  });

  it("cannot be forged through a subclass", () => {
    const Parent = safeBody().constructor as new (
      ...args: unknown[]
    ) => OutboundBody<"channel-message">;
    class Forged extends Parent {}

    expect(() => new Forged("channel-message", everyone)).toThrow(
      OutboundBodyError,
    );
    expect(() =>
      Reflect.construct(Parent, ["channel-message", everyone], Forged),
    ).toThrow(OutboundBodyError);
  });

  it("does not let its kind be rewritten", () => {
    const body = safeBody();

    expect(Object.isFrozen(body)).toBe(true);
    expect(() => {
      (body as { kind: string }).kind = "message-edit";
    }).toThrow(TypeError);
    expect(body.kind).toBe("channel-message");
  });

  it("cannot have its class or prototype patched", () => {
    const body = safeBody();

    expect(Object.isFrozen(body.constructor)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(body))).toBe(true);
  });

  it("is refused when serialized as another kind", () => {
    const edit = messageEdit({ content: safe`edit`, mentionUserIds: [] });

    expect(() =>
      // @ts-expect-error An edit body must not be accepted as a new message.
      serializeOutboundBody(edit, "channel-message"),
    ).toThrow(OutboundBodyError);
  });

  it("keeps each kind of body apart in the types", () => {
    const edit = messageEdit({ content: safe`edit`, mentionUserIds: [] });

    // @ts-expect-error An edit body must not be accepted as a new message.
    const message: OutboundBody<"channel-message"> = edit;

    expect(message.kind).toBe("message-edit");
  });
});
