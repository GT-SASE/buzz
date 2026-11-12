import { describe, expect, it, vi } from "vitest";
import { GUILD_ID, managedRow } from "../../test/support/interactions.ts";
import { fakeId } from "../../test/support/ids.ts";
import { serverError } from "../../test/support/sql-client.ts";
import { stubDb } from "../../test/support/stub-db.ts";
import { getDb, getInteractionDb } from "../db/client.ts";
import { createDiscordClient, DiscordClientError } from "../discord/client.ts";
import { threadCreate } from "../discord/outbound.ts";
import { plain, safe } from "../discord/safe-text.ts";
import { liveDependencies, managedChannelCheck } from "./dependencies.ts";

describe("liveDependencies", () => {
  it("reads with the short deadline before the acknowledgement, and the long one after", () => {
    const { db, finishDb } = liveDependencies();

    expect(db).toBe(getInteractionDb);
    expect(finishDb).toBe(getDb);
  });
});

describe("managedChannelCheck", () => {
  const CHANNEL = fakeId();
  const TOKEN = "unit-test-bot-token-value";

  it("accepts an active forum", async () => {
    const { db } = stubDb(() => ({ rows: [managedRow(CHANNEL)] }));

    await expect(
      managedChannelCheck(db).isManaged(GUILD_ID, CHANNEL),
    ).resolves.toBe(true);
  });

  it.each(["removed", "unavailable"] as const)(
    "refuses a forum that is %s",
    async (status) => {
      const { db } = stubDb(() => ({
        rows: [managedRow(CHANNEL, status)],
      }));

      await expect(
        managedChannelCheck(db).isManaged(GUILD_ID, CHANNEL),
      ).resolves.toBe(false);
    },
  );

  it("refuses a channel with no row", async () => {
    const { db } = stubDb();

    await expect(
      managedChannelCheck(db).isManaged(GUILD_ID, CHANNEL),
    ).resolves.toBe(false);
  });

  it("throws when the database cannot answer, so it is not read as unmanaged", async () => {
    const { db } = stubDb(() => serverError("XX000"));

    await expect(
      managedChannelCheck(db).isManaged(GUILD_ID, CHANNEL),
    ).rejects.toThrow("managed channel check failed");
  });

  it("refuses the send as a failed check when the database cannot answer", async () => {
    const { db } = stubDb(() => serverError("XX000"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("no network in this test"));
    const discord = createDiscordClient({
      check: managedChannelCheck(db),
      env: {
        DISCORD_BOT_TOKEN: TOKEN,
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
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("discord.com"),
      expect.anything(),
    );
    fetchSpy.mockRestore();
  });
});
