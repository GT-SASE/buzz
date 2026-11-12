import { describe, expect, it } from "vitest";
import { hasLiveSyntax } from "../../test/support/hostile-text.ts";
import { fakeId } from "../../test/support/ids.ts";
import { channelMessage } from "../discord/outbound.ts";
import { safeTextValue } from "../discord/safe-text.ts";
import { handoffMessage, toldText } from "./workflow.ts";

const GUILD = fakeId();
const TREASURY = fakeId();
const MARKETING = fakeId();
const CREATOR = fakeId();
const EVENT = { name: "Fall Social", created_by: CREATOR };
const CONFIG = {
  guild_id: GUILD,
  treasury_role_id: TREASURY,
  marketing_role_id: MARKETING,
};

function sent(input: ReturnType<typeof handoffMessage>) {
  return channelMessage(input).payload as {
    content: string;
    allowed_mentions: unknown;
  };
}

describe("handoffMessage", () => {
  it("pings only the Treasury role when Budget Sheet is done", () => {
    expect(sent(handoffMessage(CONFIG, EVENT, "budget_sheet"))).toMatchObject({
      content: `<@&${TREASURY}> Budget Sheet for **Fall Social** is done.`,
      allowed_mentions: { parse: [], users: [], roles: [TREASURY] },
    });
  });

  it("pings only the Marketing role when the Engage post is up", () => {
    expect(sent(handoffMessage(CONFIG, EVENT, "engage_post"))).toMatchObject({
      content: `<@&${MARKETING}> Engage post for **Fall Social** is up.`,
      allowed_mentions: { parse: [], users: [], roles: [MARKETING] },
    });
  });

  it("only notes in the post that the budget is approved, pinging nobody", () => {
    const body = sent(handoffMessage(CONFIG, EVENT, "budget_approved"));
    expect(body).toEqual(
      expect.objectContaining({
        content: "The budget for **Fall Social** is approved.",
        allowed_mentions: { parse: [], users: [] },
      }),
    );
    expect(body.content).not.toContain(CREATOR);
    expect(body.content).not.toMatch(/food pickup/i);
  });

  it.each([
    ["budget_sheet", "Treasury Committee", { treasury_role_id: null }],
    ["engage_post", "Marketing Committee", { marketing_role_id: null }],
    ["budget_sheet", "Treasury Committee", { treasury_role_id: GUILD }],
  ] as const)(
    "pings nobody for %s and says to choose the %s role when it is unset",
    (kind, role, unset) => {
      const body = sent(handoffMessage({ ...CONFIG, ...unset }, EVENT, kind));

      expect(body.content).toContain(`Run /setup to choose the ${role} role`);
      expect(body.content).not.toContain("<@&");
      expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
    },
  );

  it("keeps a hostile event name inert", () => {
    const input = handoffMessage(
      CONFIG,
      { ...EVENT, name: "@everyone <@&1> **x**" },
      "budget_sheet",
    );

    const content = safeTextValue(input.content);
    const name = content.slice(content.indexOf("**") + 2, -" is done.".length);

    expect(hasLiveSyntax(name.slice(0, -2))).toBe(false);
    expect(input.mentionRoleIds).toEqual([TREASURY]);
  });
});

describe("toldText", () => {
  it.each([
    ["budget_sheet", { treasury_role_id: null }],
    ["budget_sheet", { treasury_role_id: GUILD }],
    ["engage_post", { marketing_role_id: null }],
    ["engage_post", { marketing_role_id: GUILD }],
  ] as const)(
    "says nobody was pinged for %s when the role is %j",
    (kind, unset) => {
      const config = { ...CONFIG, ...unset };

      expect(safeTextValue(toldText(kind, config))).toContain(
        "so nobody was pinged",
      );
      expect(
        sent(handoffMessage(config, EVENT, kind)).allowed_mentions,
      ).toEqual({ parse: [], users: [] });
    },
  );

  it.each(["budget_sheet", "engage_post"] as const)(
    "says the role was told for %s when it was pinged",
    (kind) => {
      expect(safeTextValue(toldText(kind, CONFIG))).toMatch(/^I let the /);
    },
  );
});
