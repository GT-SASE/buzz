/**
 * /setup and /config from the router down to the real database functions, for what a
 * mock cannot prove: which writes win a race, and what the audit table ends up with.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { GuildRole } from "../../src/discord/client.ts";
import { ROUTER } from "../../src/handlers/registry.ts";
import {
  ADMINISTRATOR,
  componentPayload,
  dependenciesFor,
  fakeDiscord,
  firstCustomId,
  GUILD_ID,
  MEMBER_ID,
  run,
  setupCommandPayload,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { openBackend, type Backend } from "./backend.ts";
import { MIGRATION_OWNER, queryAs } from "./harness.ts";
import { insertEvent, insertTask } from "./fixtures.ts";

const OFFICER = fakeId();
const OTHER = fakeId();
const EBOARD = fakeId();
const COMMITTEE = fakeId();
const TREASURY = fakeId();
const MARKETING = fakeId();

function role(id: string): GuildRole {
  return { id, name: "Role", permissions: 0n, position: 1, managed: false };
}

const ROLES = [
  GUILD_ID,
  OFFICER,
  OTHER,
  EBOARD,
  COMMITTEE,
  TREASURY,
  MARKETING,
].map(role);

/** The /setup choice, with this role as Events Directors. E-board is also the admin. */
function chosen(directors: string) {
  return {
    eboard_role: role(EBOARD),
    events_directors_role: role(directors),
    events_committee_role: role(COMMITTEE),
    treasury_role: role(TREASURY),
    marketing_role: role(MARKETING),
  };
}

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

  /** Runs /setup against the real draft table and returns its Confirm custom_id. */
  async function showSetup(directors: string): Promise<string> {
    const { discord, edits } = fakeDiscord({ roles: ROLES });
    await run(
      ROUTER,
      setupCommandPayload(chosen(directors), { member: ADMINISTRATOR }),
      dependenciesFor(backend.db, discord),
    );
    return firstCustomId(edits[0]);
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
    const texts = await race(await showSetup(OFFICER));

    expect(winners(texts, "Saved.")).toBe(1);
    expect(winners(texts, "Someone else changed the roles")).toBe(1);
    expect(await configVersion()).toBe(1);
    expect(await auditRows()).toEqual([
      { actor_id: MEMBER_ID, action: "role_bindings", version_after: 1 },
    ]);
    const rows = await queryAs<Record<string, string>>(
      backend.connection,
      MIGRATION_OWNER,
      `SELECT officer_role_id, admin_role_id, eboard_role_id, events_committee_role_id,
              treasury_role_id, marketing_role_id
       FROM public.guild_config WHERE guild_id = $1`,
      [GUILD_ID],
    );
    expect(rows).toEqual([
      {
        officer_role_id: OFFICER,
        admin_role_id: EBOARD,
        eboard_role_id: EBOARD,
        events_committee_role_id: COMMITTEE,
        treasury_role_id: TREASURY,
        marketing_role_id: MARKETING,
      },
    ]);
  });

  it("lets one of two admins win a rebind, and refuses a Confirm shown before it", async () => {
    const stale = await showSetup(OFFICER);

    const texts = await race(await showSetup(OTHER));

    expect(winners(texts, "Saved.")).toBe(1);
    expect(winners(texts, "Someone else changed the roles")).toBe(1);
    expect(await configVersion()).toBe(2);
    expect(winners(await race(stale), "Someone else changed the roles")).toBe(
      2,
    );
    expect(await configVersion()).toBe(2);
  });

  it("gives a replay no second audit row", async () => {
    const { discord, edits } = fakeDiscord({ roles: ROLES });
    const dependencies = dependenciesFor(backend.db, discord);
    const before = (await auditRows()).length;
    const payload = componentPayload(await showSetup(OFFICER), {
      member: ADMINISTRATOR,
    });

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(edits).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before + 1);
  });

  describe("/config", () => {
    const FORUM = fakeId();
    const SECOND_FORUM = fakeId();
    const channel = (id: string) => ({
      id,
      name: "events",
      type: 15,
      overwrites: [],
    });
    const VIEW_AND_SEND = (1n << 10n) | (1n << 11n) | (1n << 38n);
    const discordData = {
      roles: [{ ...role(GUILD_ID), permissions: VIEW_AND_SEND }],
      channels: [FORUM, SECOND_FORUM].map(channel),
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
        adminRoleId: EBOARD,
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
  });
});
