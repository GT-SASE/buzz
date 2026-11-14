import { describe, expect, it, mock } from "bun:test";
import { GUILD_ID, managedRow } from "../../test/support/interactions.ts";
import { fakeId } from "../../test/support/ids.ts";
import { serverError } from "../../test/support/sql-client.ts";
import { stubDb } from "../../test/support/stub-db.ts";
import { stubGlobal } from "../../test/support/stubs.ts";
import { createDiscordClient, DiscordClientError } from "../discord/client.ts";
import { threadCreate } from "../discord/outbound.ts";
import { plain, safe } from "../discord/safe-text.ts";
import { managedChannelCheck } from "./dependencies.ts";

describe("managedChannelCheck", () => {
  const CHANNEL = fakeId();

  it("accepts an active forum", async () => {
    const { db } = stubDb(() => ({ rows: [managedRow(CHANNEL)] }));

    expect(await managedChannelCheck(db).isManaged(GUILD_ID, CHANNEL)).toBe(
      true,
    );
  });

  it("refuses a removed forum and a channel with no row", async () => {
    const removed = stubDb(() => ({ rows: [managedRow(CHANNEL, "removed")] }));
    const missing = stubDb();

    expect(
      await managedChannelCheck(removed.db).isManaged(GUILD_ID, CHANNEL),
    ).toBe(false);
    expect(
      await managedChannelCheck(missing.db).isManaged(GUILD_ID, CHANNEL),
    ).toBe(false);
  });

  it("refuses the send as a failed check when the database cannot answer", async () => {
    const { db } = stubDb(() => serverError("XX000"));
    const fetchStub = mock(() =>
      Promise.reject(new TypeError("no network in this test")),
    );
    stubGlobal("fetch", fetchStub);
    const discord = createDiscordClient({
      check: managedChannelCheck(db),
      env: {
        DISCORD_BOT_TOKEN: "unit-test-bot-token-value",
        DISCORD_APP_ID: fakeId(),
      },
    });

    const refused: unknown = await discord
      .createThread(
        { kind: "channel", guildId: GUILD_ID, channelId: CHANNEL },
        threadCreate({
          content: safe`text`,
          mentionUserIds: [],
          name: plain`Event`,
        }),
      )
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(DiscordClientError);
    expect((refused as DiscordClientError).failure).toEqual({
      kind: "check_failed",
      channelId: CHANNEL,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
