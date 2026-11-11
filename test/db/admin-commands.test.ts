/**
 * /setup and /config from the router down to the real database functions, for what a
 * mock cannot prove: which writes win a race, and what the audit table ends up with.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuildRole } from "../../src/discord/client.ts";
import { ROUTER } from "../../src/handlers/registry.ts";
import {
  ADMINISTRATOR,
  componentPayload,
  dependenciesFor,
  fakeDiscord,
  GUILD_ID,
  MEMBER_ID,
  run,
} from "../support/interactions.ts";
import { testSnowflake } from "../support/mock-postgrest.ts";
import { openBackend, type Backend } from "./backend.ts";
import { MIGRATION_OWNER, queryAs } from "./harness.ts";
import { insertEvent, insertTask } from "./fixtures.ts";

const OFFICER = testSnowflake();
const ADMIN = testSnowflake();
const OTHER = testSnowflake();

function role(id: string): GuildRole {
  return { id, name: "Role", permissions: 0n, position: 1, managed: false };
}

const ROLES = [role(GUILD_ID), role(OFFICER), role(ADMIN), role(OTHER)];

describe("admin commands on the real functions", () => {
  let backend: Backend;

  beforeAll(async () => {
    backend = await openBackend();
  });

  afterAll(async () => {
    await backend.close();
  });

  async function auditRows() {
    return queryAs<{ actor_id: string; action: string; version_after: number }>(
      backend.connection,
      MIGRATION_OWNER,
      `SELECT actor_id, action, version_after FROM public.config_audit
       WHERE guild_id = $1 ORDER BY id`,
      [GUILD_ID],
    );
  }

  async function configVersion() {
    const rows = await queryAs<{ version: number }>(
      backend.connection,
      MIGRATION_OWNER,
      `SELECT version FROM public.guild_config WHERE guild_id = $1`,
      [GUILD_ID],
    );
    return rows[0]?.version;
  }

  async function race(customId: string) {
    const { discord, edits } = fakeDiscord({ roles: ROLES });
    const dependencies = dependenciesFor(backend.db, discord);
    await Promise.all([
      run(
        ROUTER,
        componentPayload(customId, { member: ADMINISTRATOR }),
        dependencies,
      ),
      run(
        ROUTER,
        componentPayload(customId, { member: ADMINISTRATOR }),
        dependencies,
      ),
    ]);
    return edits.map((edit) => edit.content);
  }

  function winners(texts: readonly string[], text: string) {
    return texts.filter((item) => item.includes(text)).length;
  }

  it("lets one of two admins win the first setup, with one audit row", async () => {
    const texts = await race(`setup.confirm:0:${OFFICER}:${ADMIN}`);

    expect(winners(texts, "Saved.")).toBe(1);
    expect(winners(texts, "Someone else changed the roles")).toBe(1);
    expect(await configVersion()).toBe(1);
    expect(await auditRows()).toEqual([
      { actor_id: MEMBER_ID, action: "role_bindings", version_after: 1 },
    ]);
  });

  it("lets one of two admins win a rebind", async () => {
    const texts = await race(`setup.confirm:1:${OTHER}:${ADMIN}`);

    expect(winners(texts, "Saved.")).toBe(1);
    expect(winners(texts, "Someone else changed the roles")).toBe(1);
    expect(await configVersion()).toBe(2);
  });

  it("refuses a Confirm shown before the last save, without calling the function", async () => {
    const texts = await race(`setup.confirm:1:${OFFICER}:${ADMIN}`);

    expect(winners(texts, "Someone else changed the roles")).toBe(2);
    expect(await configVersion()).toBe(2);
  });

  it("gives a replay no second audit row", async () => {
    const { discord, edits } = fakeDiscord({ roles: ROLES });
    const dependencies = dependenciesFor(backend.db, discord);
    const before = (await auditRows()).length;
    const payload = componentPayload(`setup.confirm:2:${OFFICER}:${ADMIN}`, {
      member: ADMINISTRATOR,
    });

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(edits).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before + 1);
  });

  describe("/config", () => {
    const FORUM = testSnowflake();
    const SECOND_FORUM = testSnowflake();
    const READDED_FORUM = testSnowflake();
    const GONE_FORUM = testSnowflake();
    const channel = (id: string) => ({
      id,
      name: "events",
      type: 15,
      overwrites: [],
    });
    const VIEW_AND_SEND = (1n << 10n) | (1n << 11n) | (1n << 38n);
    const discordData = {
      roles: [{ ...role(GUILD_ID), permissions: VIEW_AND_SEND }],
      channels: [FORUM, SECOND_FORUM, READDED_FORUM, GONE_FORUM].map(channel),
      botRoleIds: [],
    };
    const addPayload = (channelId: string, version: number) =>
      componentPayload(
        `config.add:${String(version)}`,
        { member: ADMINISTRATOR, app_permissions: "0" },
        {
          component_type: 8,
          values: [channelId],
          resolved: { channels: { [channelId]: { id: channelId, type: 15 } } },
        },
      );

    function discordWorld() {
      const { discord, edits } = fakeDiscord(discordData);
      return { edits, dependencies: dependenciesFor(backend.db, discord) };
    }

    async function forumStatus(channelId: string) {
      const rows = await queryAs<{ status: string }>(
        backend.connection,
        MIGRATION_OWNER,
        `SELECT status FROM public.managed_channels
         WHERE guild_id = $1 AND channel_id = $2`,
        [GUILD_ID, channelId],
      );
      return rows[0]?.status;
    }

    it("adds a forum, then lets only one of two stale panels change it", async () => {
      const { edits, dependencies } = discordWorld();
      const version = (await configVersion()) ?? -1;

      await run(ROUTER, addPayload(FORUM, version), dependencies);
      expect(await forumStatus(FORUM)).toBe("active");
      expect(edits[0]?.content).toContain(`Added <#${FORUM}>`);

      await Promise.all([
        run(ROUTER, addPayload(SECOND_FORUM, version + 1), dependencies),
        run(
          ROUTER,
          componentPayload(`config.reminders-off:${String(version + 1)}`, {
            member: ADMINISTRATOR,
          }),
          dependencies,
        ),
      ]);

      expect(await configVersion()).toBe(version + 2);
      expect(
        edits.filter((edit) => edit.content.includes("nothing was saved")),
      ).toHaveLength(1);
    });

    it("counts open tasks, removes on the second click, and keeps the tasks", async () => {
      const { edits, dependencies } = discordWorld();
      const fixture = {
        guildId: GUILD_ID,
        officerRoleId: OFFICER,
        adminRoleId: ADMIN,
        channelId: FORUM,
      };
      const event = await insertEvent(backend.connection, fixture);
      await insertTask(backend.connection, fixture, event);
      await insertTask(backend.connection, fixture, event);
      const version = (await configVersion()) ?? -1;

      await run(
        ROUTER,
        componentPayload(
          `config.remove:${String(version)}`,
          { member: ADMINISTRATOR },
          { component_type: 3, values: [FORUM] },
        ),
        dependencies,
      );
      expect(edits[0]?.content).toContain("2 open task(s)");
      expect(await forumStatus(FORUM)).toBe("active");

      await run(
        ROUTER,
        componentPayload(`config.remove-yes:${String(version)}:${FORUM}`, {
          member: ADMINISTRATOR,
        }),
        dependencies,
      );
      expect(await forumStatus(FORUM)).toBe("removed");
      const tasks = await queryAs(
        backend.connection,
        MIGRATION_OWNER,
        `SELECT id FROM public.tasks WHERE guild_id = $1 AND status = 'open'`,
        [GUILD_ID],
      );
      expect(tasks).toHaveLength(2);
    });

    it("draws the panel from real rows, with the audit trail", async () => {
      const { edits, dependencies } = discordWorld();

      await run(
        ROUTER,
        componentPayload("config.view", { member: ADMINISTRATOR }),
        dependencies,
      );

      expect(edits[0]?.content).toContain("Bot settings");
      expect(edits[0]?.content).toContain(`removed <#${FORUM}>`);
      expect(edits[0]?.content).toContain(`<@${MEMBER_ID}>`);
    });

    it("refuses removing the same forum twice, with a message and no text from the database", async () => {
      const { edits, dependencies } = discordWorld();
      const version = (await configVersion()) ?? -1;

      await run(
        ROUTER,
        componentPayload(`config.remove-yes:${String(version)}:${FORUM}`, {
          member: ADMINISTRATOR,
        }),
        dependencies,
      );

      expect(edits[0]?.content).toContain("no longer possible");
      expect(await configVersion()).toBe(version);
    });

    it("brings a post up to date when its forum is added back, even for a closed event", async () => {
      const { discord, edits } = fakeDiscord(discordData);
      const posted: { messageId: string; content: unknown }[] = [];
      const dependencies = dependenciesFor(backend.db, {
        ...discord,
        editMessage: (_target, messageId, body) => {
          posted.push({
            messageId,
            content: (body.toJSON() as { content: unknown }).content,
          });
          return Promise.resolve({ id: messageId });
        },
      });
      await run(
        ROUTER,
        addPayload(READDED_FORUM, (await configVersion()) ?? -1),
        dependencies,
      );
      const message = testSnowflake();
      const closed = await insertEvent(backend.connection, {
        guildId: GUILD_ID,
        officerRoleId: OFFICER,
        adminRoleId: ADMIN,
        channelId: READDED_FORUM,
      });
      await queryAs(
        backend.connection,
        MIGRATION_OWNER,
        `UPDATE public.events
         SET thread_id = $2, thread_status = 'active', overview_message_id = $3
         WHERE id = $1`,
        [closed, testSnowflake(), message],
      );
      await run(
        ROUTER,
        componentPayload(
          `config.remove-yes:${String((await configVersion()) ?? -1)}:${READDED_FORUM}`,
          { member: ADMINISTRATOR },
        ),
        dependencies,
      );
      await queryAs(
        backend.connection,
        MIGRATION_OWNER,
        `UPDATE public.events SET status = 'closed' WHERE id = $1`,
        [closed],
      );
      expect(posted).toEqual([]);

      await run(
        ROUTER,
        addPayload(READDED_FORUM, (await configVersion()) ?? -1),
        dependencies,
      );

      expect(await forumStatus(READDED_FORUM)).toBe("active");
      expect(posted).toHaveLength(1);
      expect(posted[0]?.messageId).toBe(message);
      expect(posted[0]?.content).toContain("Status: Closed");
      expect(edits.at(-1)?.content).toContain("event post(s) are up to date");
    });

    it("shows which forum went when an unavailable one is removed", async () => {
      const { edits, dependencies } = discordWorld();
      await run(
        ROUTER,
        addPayload(GONE_FORUM, (await configVersion()) ?? -1),
        dependencies,
      );
      await queryAs(
        backend.connection,
        "service_role",
        `SELECT public.mark_channel_unavailable($1, $2)`,
        [GUILD_ID, GONE_FORUM],
      );

      await run(
        ROUTER,
        componentPayload(
          `config.remove-yes:${String((await configVersion()) ?? -1)}:${GONE_FORUM}`,
          { member: ADMINISTRATOR },
        ),
        dependencies,
      );

      expect(await forumStatus(GONE_FORUM)).toBe("removed");
      expect(edits.at(-1)?.content).toContain(`removed <#${GONE_FORUM}>`);
    });
  });
});
