import { describe, expect, it } from "bun:test";
import { hasLiveSyntax } from "../../test/support/hostile-text.ts";
import { fakeId } from "../../test/support/ids.ts";
import { channelMessage } from "../discord/outbound.ts";
import { safeTextValue } from "../discord/safe-text.ts";
import { handoffMessage, toldText } from "./workflow.ts";

const GUILD = fakeId();
const TREASURY = fakeId();
const MARKETING = fakeId();
const EVENT = { name: "Fall Social", created_by: fakeId() };
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
  it("pings only Treasury for Budget Sheet and only Marketing for Engage", () => {
    expect(sent(handoffMessage(CONFIG, EVENT, "budget_sheet"))).toMatchObject({
      content: `<@&${TREASURY}> Budget Sheet for **Fall Social** is done.`,
      allowed_mentions: { parse: [], users: [], roles: [TREASURY] },
    });
    expect(sent(handoffMessage(CONFIG, EVENT, "engage_post"))).toMatchObject({
      content: `<@&${MARKETING}> Engage post for **Fall Social** is up.`,
      allowed_mentions: { parse: [], users: [], roles: [MARKETING] },
    });
  });

  it("only notes that the budget is approved, pinging nobody", () => {
    const body = sent(handoffMessage(CONFIG, EVENT, "budget_approved"));
    expect(body.content).toBe("The budget for **Fall Social** is approved.");
    expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it.each([
    ["budget_sheet", "Treasury Committee", { treasury_role_id: null }],
    ["engage_post", "Marketing Committee", { marketing_role_id: GUILD }],
  ] as const)(
    "pings nobody for %s and says to choose the %s role when it is unset",
    (kind, role, unset) => {
      const config = { ...CONFIG, ...unset };
      const body = sent(handoffMessage(config, EVENT, kind));

      expect(body.content).toContain(`Run /setup to choose the ${role} role`);
      expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
      expect(safeTextValue(toldText(kind, config))).toContain(
        "so nobody was pinged",
      );
    },
  );

  it("says the role was told when it was pinged", () => {
    expect(safeTextValue(toldText("budget_sheet", CONFIG))).toMatch(
      /^I let the /,
    );
  });

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
