import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../handlers/registry.ts";
import type { Actor } from "./actor.ts";
import {
  assertPublicRowsUnscoped,
  authorize,
  autocompleteScope,
  canApproveBudget,
  canCompleteStep,
  COMMAND_POLICY,
  holdsTierFor,
  isAction,
  isAutocompleteCommand,
  isOfficer,
  REFUSED,
  type Action,
  type AuthorizationConfig,
  type AutocompleteCommand,
  type Decision,
  type EventResource,
  type Scope,
  type TaskResource,
  type Tier,
} from "./permissions.ts";

const GUILD = "1".repeat(18);
const OTHER_GUILD = "2".repeat(18);
const OFFICER_ROLE = "3".repeat(18);
const ADMIN_ROLE = "4".repeat(18);
const UNRELATED_ROLE = "5".repeat(18);
const USER = "6".repeat(18);
const OTHER_USER = "7".repeat(18);
const EBOARD_ROLE = "8".repeat(18);
const TREASURY_ROLE = "9".repeat(18);
const DELETED_AT = "2026-01-01T00:00:00Z";

const CONFIG: AuthorizationConfig = {
  guild_id: GUILD,
  officer_role_id: OFFICER_ROLE,
  admin_role_id: ADMIN_ROLE,
  eboard_role_id: EBOARD_ROLE,
  treasury_role_id: TREASURY_ROLE,
};

const EVENT: EventResource = { guild_id: GUILD, deleted_at: null };
const OWN_TASK: TaskResource = { ...EVENT, assignee_id: USER };
const OTHERS_TASK: TaskResource = { ...EVENT, assignee_id: OTHER_USER };

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: USER,
    guildId: GUILD,
    roleIds: new Set(),
    isAdministrator: false,
    ...overrides,
  };
}

const MEMBER = actor({ roleIds: new Set([UNRELATED_ROLE]) });
const OFFICER = actor({ roleIds: new Set([OFFICER_ROLE]) });
const ADMIN = actor({ roleIds: new Set([ADMIN_ROLE]) });
const ADMINISTRATOR = actor({ isAdministrator: true });
const EBOARD = actor({ roleIds: new Set([EBOARD_ROLE]) });
const TREASURY = actor({ roleIds: new Set([TREASURY_ROLE]) });
const EVERY_KIND = [MEMBER, OFFICER, EBOARD, TREASURY, ADMIN, ADMINISTRATOR];

/** Written out by hand, so a slip in the policy would have to be made twice. */
const EXPECTED_ACTIONS: readonly (readonly [string, Tier, Scope])[] = [
  ["setup", "bindings", "none"],
  ["config.view", "admin", "none"],
  ["config.change", "admin", "none"],
  ["event.create", "officer", "none"],
  ["event.link", "officer", "none"],
  ["event.status", "officer", "event"],
  ["event.list", "officer", "none"],
  ["event.close", "officer", "event"],
  ["event.delete", "officer", "event"],
  ["event.assign", "officer", "event"],
  ["event.unassign", "officer", "event"],
  ["event.pickup", "officer", "event"],
  ["event.approve_budget", "budget", "event"],
  ["event.step_done", "self", "none"],
  ["task.assign", "officer", "event"],
  ["task.edit", "officer", "task"],
  ["task.delete", "officer", "task"],
  ["task.done", "self", "task"],
  ["ping", "public", "none"],
  ["mytasks", "self", "none"],
];

const EXPECTED_POLICY = new Map<string, Tier>(
  EXPECTED_ACTIONS.map(([action, tier]) => [action, tier]),
);

function actionsInScope(...scopes: Scope[]): string[] {
  return EXPECTED_ACTIONS.filter(([, , scope]) => scopes.includes(scope)).map(
    ([action]) => action,
  );
}

const EVENT_SCOPED = actionsInScope("event");
const OFFICER_TASK_SCOPED = ["task.edit", "task.delete"];

/**
 * For input the types refuse: names that are not actions, rows missing a column,
 * and tables looping over every action. This cast steps around ResourceArgs, so
 * tests of what compiles call authorize directly.
 */
const decide = authorize as (
  action: string,
  actor: Actor,
  config: AuthorizationConfig | null | undefined,
  resource?: EventResource | null,
) => Decision;

/** A row that passes every object check, for tests about the tier alone. */
function rowFor(action: string): TaskResource {
  return action === "task.done" ? OWN_TASK : OTHERS_TASK;
}

describe("COMMAND_POLICY", () => {
  it("is a Map", () => {
    expect(COMMAND_POLICY).toBeInstanceOf(Map);
  });

  it.each([...EXPECTED_POLICY])("maps %s to %s", (action, tier) => {
    expect(COMMAND_POLICY.get(action)).toBe(tier);
  });

  it("maps nothing else", () => {
    expect([...COMMAND_POLICY.keys()].sort()).toEqual(
      [...EXPECTED_POLICY.keys()].sort(),
    );
  });

  it.each(actionsInScope("event", "task"))(
    "%s is refused with no row, even for the highest tier",
    (action) => {
      expect(decide(action, ADMINISTRATOR, CONFIG)).toBe(REFUSED);
    },
  );

  it.each(actionsInScope("none"))("%s needs no row", (action) => {
    expect(decide(action, ADMINISTRATOR, CONFIG).allowed).toBe(true);
  });

  // /config takes no subcommand: opening its panel is what the action names.
  const PANEL_ACTIONS = new Map([["config", "config.view"]]);

  interface RegisteredCommand {
    name: string;
    options?: readonly { type: ApplicationCommandOptionType; name: string }[];
  }

  function actionsOf(command: RegisteredCommand): string[] {
    const subcommands = (command.options ?? []).filter(
      (option) => option.type === ApplicationCommandOptionType.Subcommand,
    );
    return subcommands.length > 0
      ? subcommands.map((option) => `${command.name}.${option.name}`)
      : [PANEL_ACTIONS.get(command.name) ?? command.name];
  }

  it("has an entry for every registered command and subcommand", () => {
    const commands = COMMANDS as readonly RegisteredCommand[];
    const unmapped = commands
      .flatMap(actionsOf)
      .filter((action) => !COMMAND_POLICY.has(action));

    expect(unmapped).toEqual([]);
  });

  it("would catch a registered command with no entry", () => {
    expect(
      actionsOf({
        name: "event",
        options: [
          { type: ApplicationCommandOptionType.Subcommand, name: "rename" },
        ],
      }).filter((action) => !COMMAND_POLICY.has(action)),
    ).toEqual(["event.rename"]);
  });
});

describe("the public tier", () => {
  it.each(["event", "task"] as const)(
    "refuses at load a public action with scope %s",
    (scope) => {
      expect(() => {
        assertPublicRowsUnscoped([["x", "public", scope]]);
      }).toThrow("must have scope none");
    },
  );

  it("accepts a public action with no scope, and a scoped one at another tier", () => {
    expect(() => {
      assertPublicRowsUnscoped([
        ["x", "public", "none"],
        ["y", "officer", "event"],
      ]);
    }).not.toThrow();
  });

  // /ping reveals nothing, and has to work before setup so that a new deployment
  // can be checked.
  it("allows ping before setup, for anyone", () => {
    expect(authorize("ping", MEMBER, null).allowed).toBe(true);
  });

  it("allows nothing else before setup, except bindings for an administrator", () => {
    const allowed = [...COMMAND_POLICY.keys()].filter(
      (action) => decide(action as Action, MEMBER, null).allowed,
    );

    expect(allowed).toEqual(["ping"]);
  });
});

describe("unmapped actions", () => {
  it.each([
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
    "pong",
    "",
    "EVENT.CREATE",
    "event.create ",
    "event",
    "setup:autocomplete",
    "event.close:autocomplete",
    "task.done:autocomplete",
    "constructor:autocomplete",
  ])("refuses %j for every kind of actor", (action) => {
    expect(isAction(action)).toBe(false);
    for (const who of EVERY_KIND) {
      expect(decide(action, who, CONFIG, OWN_TASK)).toBe(REFUSED);
      expect(decide(action, who, null, OWN_TASK)).toBe(REFUSED);
    }
  });

  it("recognises mapped names", () => {
    expect(isAction("setup")).toBe(true);
    expect(isAction("task.done")).toBe(true);
  });
});

describe("tiers", () => {
  const allowedBy: Record<Tier, readonly Actor[]> = {
    public: EVERY_KIND,
    self: EVERY_KIND,
    officer: [OFFICER, EBOARD, ADMIN, ADMINISTRATOR],
    budget: [OFFICER, EBOARD, TREASURY, ADMIN, ADMINISTRATOR],
    admin: [ADMIN, ADMINISTRATOR],
    bindings: [ADMINISTRATOR],
  };

  // task.done has its own tests, because being the assignee matters there.
  it.each([...EXPECTED_POLICY].filter(([action]) => action !== "task.done"))(
    "%s allows only tier %s",
    (action, tier) => {
      for (const who of EVERY_KIND) {
        expect(decide(action, who, CONFIG, rowFor(action)).allowed).toBe(
          allowedBy[tier].includes(who),
        );
      }
    },
  );

  it("does not let admin_role_id run setup", () => {
    expect(authorize("setup", ADMIN, CONFIG)).toBe(REFUSED);
    expect(authorize("setup", ADMIN, null)).toBe(REFUSED);
  });

  it("does not let officer_role_id run setup", () => {
    expect(authorize("setup", OFFICER, CONFIG)).toBe(REFUSED);
  });

  describe("stacking", () => {
    it.each([
      ["admin_role_id", ADMIN],
      ["the Administrator bit", ADMINISTRATOR],
    ])("gives %s officer rights", (_label, who) => {
      expect(authorize("event.create", who, CONFIG).allowed).toBe(true);
      expect(authorize("event.close", who, CONFIG, EVENT).allowed).toBe(true);
      expect(authorize("task.edit", who, CONFIG, OTHERS_TASK).allowed).toBe(
        true,
      );
    });

    it("does not give officer_role_id admin rights", () => {
      expect(authorize("config.view", OFFICER, CONFIG)).toBe(REFUSED);
      expect(authorize("config.change", OFFICER, CONFIG)).toBe(REFUSED);
    });

    it("does not spare an admin the checks on the row", () => {
      for (const who of [ADMIN, ADMINISTRATOR]) {
        expect(authorize("event.close", who, CONFIG, null)).toBe(REFUSED);
        expect(
          authorize("event.close", who, CONFIG, {
            ...EVENT,
            guild_id: OTHER_GUILD,
          }),
        ).toBe(REFUSED);
        expect(
          authorize("event.close", who, CONFIG, {
            ...EVENT,
            deleted_at: DELETED_AT,
          }),
        ).toBe(REFUSED);
      }
    });

    it("does not reach officer actions before setup", () => {
      expect(authorize("event.create", ADMINISTRATOR, null)).toBe(REFUSED);
    });
  });

  describe("event.link", () => {
    it("takes no row, because it creates one", () => {
      expect(authorize("event.link", OFFICER, CONFIG).allowed).toBe(true);
      // @ts-expect-error event.link has no existing row to check
      expect(authorize("event.link", OFFICER, CONFIG, EVENT).allowed).toBe(
        true,
      );
    });

    it("stays at the officer tier", () => {
      expect(authorize("event.link", MEMBER, CONFIG)).toBe(REFUSED);
      expect(authorize("event.link", ADMIN, CONFIG).allowed).toBe(true);
    });

    it("is refused before setup", () => {
      expect(authorize("event.link", ADMINISTRATOR, null)).toBe(REFUSED);
    });
  });

  it("allows setup again once configured, for the Administrator bit", () => {
    expect(authorize("setup", ADMINISTRATOR, CONFIG).allowed).toBe(true);
  });
});

describe("before setup", () => {
  it.each([null, undefined])("with config %s allows only setup", (config) => {
    expect(authorize("setup", ADMINISTRATOR, config).allowed).toBe(true);
    for (const action of EXPECTED_POLICY.keys()) {
      if (action !== "setup" && EXPECTED_POLICY.get(action) !== "public") {
        expect(decide(action, ADMINISTRATOR, config, rowFor(action))).toBe(
          REFUSED,
        );
      }
    }
  });

  it("still requires the Administrator bit for setup", () => {
    for (const who of [MEMBER, OFFICER, ADMIN]) {
      expect(authorize("setup", who, null)).toBe(REFUSED);
    }
  });

  it("refuses the self tier too", () => {
    expect(authorize("mytasks", MEMBER, null)).toBe(REFUSED);
    expect(authorize("task.done", MEMBER, null, OWN_TASK)).toBe(REFUSED);
  });
});

describe("another guild's config", () => {
  const foreign: AuthorizationConfig = { ...CONFIG, guild_id: OTHER_GUILD };

  it("refuses every action, whatever the actor holds", () => {
    const holdsAll = actor({
      roleIds: new Set([OFFICER_ROLE, ADMIN_ROLE]),
      isAdministrator: true,
    });
    for (const action of EXPECTED_POLICY.keys()) {
      if (EXPECTED_POLICY.get(action) === "public") continue;
      expect(decide(action, holdsAll, foreign, rowFor(action))).toBe(REFUSED);
    }
  });
});

describe("object-scoped actions", () => {
  describe.each([...EVENT_SCOPED, ...OFFICER_TASK_SCOPED])("%s", (action) => {
    it("allows an officer on a live row in the guild", () => {
      expect(decide(action, OFFICER, CONFIG, OTHERS_TASK).allowed).toBe(true);
    });

    it("refuses an absent row", () => {
      expect(decide(action, OFFICER, CONFIG, null)).toBe(REFUSED);
      expect(decide(action, OFFICER, CONFIG, undefined)).toBe(REFUSED);
      expect(decide(action, OFFICER, CONFIG)).toBe(REFUSED);
    });

    it("refuses another guild's row", () => {
      expect(
        decide(action, OFFICER, CONFIG, {
          ...OTHERS_TASK,
          guild_id: OTHER_GUILD,
        }),
      ).toBe(REFUSED);
    });

    it("refuses a deleted row", () => {
      expect(
        decide(action, OFFICER, CONFIG, {
          ...OTHERS_TASK,
          deleted_at: DELETED_AT,
        }),
      ).toBe(REFUSED);
    });

    it("refuses a row read without its deleted_at column", () => {
      const incomplete = { guild_id: GUILD } as EventResource;

      expect(decide(action, OFFICER, CONFIG, incomplete)).toBe(REFUSED);
    });

    it("refuses a member on a live row", () => {
      expect(decide(action, MEMBER, CONFIG, OTHERS_TASK)).toBe(REFUSED);
    });
  });

  it("does not let an assignee edit or delete their own task", () => {
    for (const action of OFFICER_TASK_SCOPED) {
      expect(decide(action, MEMBER, CONFIG, OWN_TASK)).toBe(REFUSED);
    }
  });

  describe("task.done", () => {
    it("allows the assignee, with no bound role", () => {
      expect(authorize("task.done", MEMBER, CONFIG, OWN_TASK).allowed).toBe(
        true,
      );
    });

    it("allows an officer who is not the assignee", () => {
      expect(authorize("task.done", OFFICER, CONFIG, OTHERS_TASK).allowed).toBe(
        true,
      );
    });

    it("refuses a non-assignee", () => {
      expect(authorize("task.done", MEMBER, CONFIG, OTHERS_TASK)).toBe(REFUSED);
    });

    it.each([
      ["admin_role_id", ADMIN],
      ["the Administrator bit", ADMINISTRATOR],
    ])("allows a non-assignee holding %s", (_label, who) => {
      expect(authorize("task.done", who, CONFIG, OTHERS_TASK).allowed).toBe(
        true,
      );
    });

    it("refuses an absent row, even for an officer", () => {
      expect(authorize("task.done", OFFICER, CONFIG, null)).toBe(REFUSED);
      expect(authorize("task.done", MEMBER, CONFIG, undefined)).toBe(REFUSED);
    });

    it("refuses the assignee on another guild's row", () => {
      expect(
        authorize("task.done", MEMBER, CONFIG, {
          ...OWN_TASK,
          guild_id: OTHER_GUILD,
        }),
      ).toBe(REFUSED);
    });

    it("refuses the assignee on a deleted row", () => {
      expect(
        authorize("task.done", MEMBER, CONFIG, {
          ...OWN_TASK,
          deleted_at: DELETED_AT,
        }),
      ).toBe(REFUSED);
    });

    it("refuses a row read without its assignee_id column", () => {
      expect(decide("task.done", MEMBER, CONFIG, EVENT)).toBe(REFUSED);
    });
  });

  it("requires the row by type", () => {
    // @ts-expect-error an object-scoped action cannot leave out its row
    expect(authorize("event.close", OFFICER, CONFIG)).toBe(REFUSED);
    // @ts-expect-error an object-scoped action cannot leave out its row
    expect(authorize("task.done", OFFICER, CONFIG)).toBe(REFUSED);
    // @ts-expect-error task.done needs a task row, with its assignee
    expect(authorize("task.done", MEMBER, CONFIG, EVENT)).toBe(REFUSED);
  });

  it("takes no row where there is none to check", () => {
    // @ts-expect-error an action with no object takes no row
    expect(authorize("mytasks", MEMBER, CONFIG, OWN_TASK).allowed).toBe(true);
  });

  describe("an action not narrowed to one scope", () => {
    // Each cast widens a literal to the union under test. Nothing here goes through
    // decide, so the compiler sees the real signature.
    const bare = "event.close" as Action;
    const noneOrEvent = "event.close" as "mytasks" | "event.close";
    const noneOrTask = "task.done" as "mytasks" | "task.done";
    const eventOrTask = "task.done" as "event.close" | "task.done";

    it("has no valid call for a bare Action", () => {
      // @ts-expect-error a bare Action might need a row
      expect(authorize(bare, OFFICER, CONFIG)).toBe(REFUSED);
      // @ts-expect-error a bare Action might refuse a row
      expect(authorize(bare, OFFICER, CONFIG, EVENT).allowed).toBe(true);
    });

    it("has no valid call for a union of no row and an event row", () => {
      // @ts-expect-error one member of the union needs a row
      expect(authorize(noneOrEvent, OFFICER, CONFIG)).toBe(REFUSED);
      // @ts-expect-error one member of the union takes no row
      expect(authorize(noneOrEvent, OFFICER, CONFIG, EVENT).allowed).toBe(true);
    });

    it("has no valid call for a union of no row and a task row", () => {
      // @ts-expect-error one member of the union needs a row
      expect(authorize(noneOrTask, MEMBER, CONFIG)).toBe(REFUSED);
      // @ts-expect-error one member of the union takes no row
      expect(authorize(noneOrTask, MEMBER, CONFIG, OWN_TASK).allowed).toBe(
        true,
      );
    });

    it("has no valid call for a union of an event row and a task row", () => {
      // @ts-expect-error both members need a row
      expect(authorize(eventOrTask, MEMBER, CONFIG)).toBe(REFUSED);
      // @ts-expect-error the members need different rows
      expect(authorize(eventOrTask, MEMBER, CONFIG, OWN_TASK).allowed).toBe(
        true,
      );
    });

    it("allows a union that needs the same thing throughout", () => {
      const noRow = "mytasks" as "mytasks" | "event.list";
      const eventRow = "event.close" as "event.close" | "event.status";
      const taskRow = "task.edit" as "task.edit" | "task.done";

      expect(authorize(noRow, MEMBER, CONFIG).allowed).toBe(true);
      expect(authorize(eventRow, OFFICER, CONFIG, EVENT).allowed).toBe(true);
      expect(authorize(taskRow, OFFICER, CONFIG, OWN_TASK).allowed).toBe(true);
    });
  });
});

describe("the event workflow actions", () => {
  it("lets only the officer tier assign people and set the pickup time", () => {
    for (const action of [
      "event.assign",
      "event.unassign",
      "event.pickup",
    ] as const) {
      expect(authorize(action, OFFICER, CONFIG, EVENT).allowed).toBe(true);
      expect(authorize(action, EBOARD, CONFIG, EVENT).allowed).toBe(true);
      expect(authorize(action, TREASURY, CONFIG, EVENT)).toBe(REFUSED);
      expect(authorize(action, MEMBER, CONFIG, EVENT)).toBe(REFUSED);
    }
  });

  it("lets Treasury approve a budget, on a live row of its own guild only", () => {
    expect(
      authorize("event.approve_budget", TREASURY, CONFIG, EVENT).allowed,
    ).toBe(true);
    expect(authorize("event.approve_budget", MEMBER, CONFIG, EVENT)).toBe(
      REFUSED,
    );
    expect(
      authorize("event.approve_budget", TREASURY, CONFIG, {
        ...EVENT,
        deleted_at: DELETED_AT,
      }),
    ).toBe(REFUSED);
    expect(
      authorize("event.approve_budget", TREASURY, CONFIG, {
        ...EVENT,
        guild_id: OTHER_GUILD,
      }),
    ).toBe(REFUSED);
  });

  it("leaves marking a step done to the handler's check on the assignees", () => {
    // Anyone in a set-up guild gets past the gate. canCompleteStep decides.
    expect(authorize("event.step_done", MEMBER, CONFIG).allowed).toBe(true);
    expect(authorize("event.step_done", MEMBER, null)).toBe(REFUSED);
    expect(canCompleteStep(MEMBER, CONFIG, [])).toBe(false);
    expect(canCompleteStep(MEMBER, CONFIG, [USER])).toBe(true);
  });
});

describe("autocompleteScope", () => {
  const OFFICER_COMMANDS: readonly AutocompleteCommand[] = [
    "task.assign",
    "event.link",
    "event.status",
    "event.close",
    "event.delete",
    "event.assign",
    "event.unassign",
    "event.pickup",
    "task.edit",
    "task.delete",
  ];
  const ALL_COMMANDS: readonly AutocompleteCommand[] = [
    ...OFFICER_COMMANDS,
    "task.done",
  ];

  it.each(OFFICER_COMMANDS)("%s lists the guild for officers", (command) => {
    for (const who of [OFFICER, ADMIN, ADMINISTRATOR]) {
      expect(autocompleteScope(command, who, CONFIG)).toEqual({
        guildId: GUILD,
      });
    }
  });

  it.each(OFFICER_COMMANDS)("%s is refused for a member", (command) => {
    expect(autocompleteScope(command, MEMBER, CONFIG)).toBeUndefined();
  });

  it("limits task.done to a member's own tasks", () => {
    expect(autocompleteScope("task.done", MEMBER, CONFIG)).toEqual({
      guildId: GUILD,
      assigneeId: USER,
    });
  });

  it.each([
    ["officer_role_id", OFFICER],
    ["admin_role_id", ADMIN],
    ["the Administrator bit", ADMINISTRATOR],
  ])("does not limit task.done for %s", (_label, who) => {
    expect(autocompleteScope("task.done", who, CONFIG)).toEqual({
      guildId: GUILD,
    });
  });

  it.each(ALL_COMMANDS)("%s is refused before setup", (command) => {
    for (const who of EVERY_KIND) {
      expect(autocompleteScope(command, who, null)).toBeUndefined();
      expect(autocompleteScope(command, who, undefined)).toBeUndefined();
    }
  });

  it.each(ALL_COMMANDS)(
    "%s is refused with another guild's config",
    (command) => {
      const foreign = { ...CONFIG, guild_id: OTHER_GUILD };

      expect(
        autocompleteScope(command, ADMINISTRATOR, foreign),
      ).toBeUndefined();
    },
  );

  it("takes the guild and assignee from the actor", () => {
    const elsewhere = actor({ guildId: OTHER_GUILD, userId: OTHER_USER });
    const config = { ...CONFIG, guild_id: OTHER_GUILD };

    expect(autocompleteScope("task.done", elsewhere, config)).toEqual({
      guildId: OTHER_GUILD,
      assigneeId: OTHER_USER,
    });
  });

  it.each([
    "setup",
    "config.view",
    "config.change",
    "event.create",
    "event.list",
    "mytasks",
    "constructor",
    "toString",
    "__proto__",
    "event.close:autocomplete",
    "",
  ])("refuses %j, which has no autocomplete option", (command) => {
    expect(isAutocompleteCommand(command)).toBe(false);
    expect(
      autocompleteScope(command as AutocompleteCommand, ADMINISTRATOR, CONFIG),
    ).toBeUndefined();
  });

  it.each(ALL_COMMANDS)("recognises %s", (command) => {
    expect(isAutocompleteCommand(command)).toBe(true);
  });

  it("accepts only listed commands by type", () => {
    // @ts-expect-error mytasks has no autocomplete option
    expect(autocompleteScope("mytasks", MEMBER, CONFIG)).toBeUndefined();
    // @ts-expect-error event.create has no autocomplete option
    expect(autocompleteScope("event.create", OFFICER, CONFIG)).toBeUndefined();
  });
});

describe("a bound role that equals the guild ID", () => {
  const holdsGuildId = actor({ roleIds: new Set([GUILD]) });
  const officerBound = { ...CONFIG, officer_role_id: GUILD };
  const adminBound = { ...CONFIG, admin_role_id: GUILD };

  it("does not make anyone an officer", () => {
    expect(isOfficer(holdsGuildId, officerBound)).toBe(false);
    expect(authorize("event.create", holdsGuildId, officerBound)).toBe(REFUSED);
    expect(
      autocompleteScope("event.close", holdsGuildId, officerBound),
    ).toBeUndefined();
    expect(autocompleteScope("task.done", holdsGuildId, officerBound)).toEqual({
      guildId: GUILD,
      assigneeId: USER,
    });
  });

  it("does not make anyone an admin, or an officer through it", () => {
    expect(authorize("config.view", holdsGuildId, adminBound)).toBe(REFUSED);
    expect(isOfficer(holdsGuildId, adminBound)).toBe(false);
  });

  it("does not take the Administrator bit away", () => {
    const both = { ...officerBound, admin_role_id: GUILD };

    expect(authorize("config.view", ADMINISTRATOR, both).allowed).toBe(true);
    expect(isOfficer(ADMINISTRATOR, both)).toBe(true);
  });

  it("leaves the other bound role working", () => {
    expect(isOfficer(ADMIN, officerBound)).toBe(true);
    expect(isOfficer(OFFICER, adminBound)).toBe(true);
  });
});

describe("the refusal", () => {
  it("is one object for every cause", () => {
    const causes = [
      decide("constructor", MEMBER, CONFIG),
      decide("event.create", MEMBER, CONFIG),
      decide("mytasks", MEMBER, null),
      decide("task.done", MEMBER, CONFIG, null),
      decide("task.done", MEMBER, CONFIG, OTHERS_TASK),
      decide("task.done", MEMBER, CONFIG, {
        ...OWN_TASK,
        guild_id: OTHER_GUILD,
      }),
      decide("task.done", MEMBER, CONFIG, {
        ...OWN_TASK,
        deleted_at: DELETED_AT,
      }),
      decide("mytasks", MEMBER, { ...CONFIG, guild_id: OTHER_GUILD }),
    ];

    expect(causes.every((decision) => decision === REFUSED)).toBe(true);
    expect(REFUSED.allowed).toBe(false);
  });

  it("cannot be changed by a caller", () => {
    expect(Object.isFrozen(REFUSED)).toBe(true);
    expect(Object.isFrozen(authorize("mytasks", MEMBER, CONFIG))).toBe(true);
  });
});

describe("roles removed since a panel opened", () => {
  it("refuses the submit, judged on the payload that carried it", () => {
    const whenOpened = actor({ roleIds: new Set([OFFICER_ROLE]) });
    const whenSubmitted = actor({ roleIds: new Set() });

    expect(
      authorize("task.edit", whenOpened, CONFIG, OTHERS_TASK).allowed,
    ).toBe(true);
    expect(authorize("task.edit", whenSubmitted, CONFIG, OTHERS_TASK)).toBe(
      REFUSED,
    );
  });

  it("refuses a config change after the admin role is removed", () => {
    expect(authorize("config.change", ADMIN, CONFIG).allowed).toBe(true);
    expect(authorize("config.change", actor(), CONFIG)).toBe(REFUSED);
  });

  it("takes officer rights away with the admin role", () => {
    expect(authorize("task.edit", ADMIN, CONFIG, OTHERS_TASK).allowed).toBe(
      true,
    );
    expect(authorize("task.edit", actor(), CONFIG, OTHERS_TASK)).toBe(REFUSED);
  });

  it("refuses a setup confirm after losing the Administrator bit", () => {
    expect(authorize("setup", ADMINISTRATOR, null).allowed).toBe(true);
    expect(authorize("setup", actor(), null)).toBe(REFUSED);
  });
});

describe("isOfficer", () => {
  it("is true for the officer role and for admins", () => {
    expect(isOfficer(OFFICER, CONFIG)).toBe(true);
    expect(isOfficer(ADMIN, CONFIG)).toBe(true);
    expect(isOfficer(ADMINISTRATOR, CONFIG)).toBe(true);
    expect(isOfficer(MEMBER, CONFIG)).toBe(false);
  });

  it.each([
    ["officer_role_id", OFFICER],
    ["admin_role_id", ADMIN],
    ["the Administrator bit", ADMINISTRATOR],
  ])("needs a config for the actor's guild, even with %s", (_label, who) => {
    expect(isOfficer(who, null)).toBe(false);
    expect(isOfficer(who, undefined)).toBe(false);
    expect(isOfficer(who, { ...CONFIG, guild_id: OTHER_GUILD })).toBe(false);
  });
});

// The same bits through the real parser are in actor.test.ts. These two tie that
// result to the tiers it decides.
describe("high permission bits", () => {
  const withBits = (bits: bigint) =>
    actor({ isAdministrator: (bits & (1n << 3n)) === 1n << 3n });

  it("refuses bindings and admin when Administrator is absent", () => {
    const who = withBits((1n << 54n) | 7n);

    expect(authorize("setup", who, CONFIG)).toBe(REFUSED);
    expect(authorize("config.change", who, CONFIG)).toBe(REFUSED);
  });

  it("allows them when Administrator is present", () => {
    const who = withBits((1n << 60n) | (1n << 3n));

    expect(authorize("setup", who, CONFIG).allowed).toBe(true);
    expect(authorize("config.change", who, CONFIG).allowed).toBe(true);
  });
});

describe("holdsTierFor", () => {
  const GUILD = "1".repeat(18);
  const OFFICER_ROLE_ID = "2".repeat(18);
  const ADMIN_ROLE_ID = "3".repeat(18);
  const USER = "4".repeat(18);
  const config = {
    guild_id: GUILD,
    officer_role_id: OFFICER_ROLE_ID,
    admin_role_id: ADMIN_ROLE_ID,
    eboard_role_id: null,
    treasury_role_id: null,
  };
  const actorWith = (roleIds: string[], isAdministrator = false) => ({
    userId: USER,
    guildId: GUILD,
    roleIds: new Set(roleIds),
    isAdministrator,
  });

  it.each([
    ["task.edit", actorWith([]), false],
    ["task.edit", actorWith([OFFICER_ROLE_ID]), true],
    ["task.edit", actorWith([ADMIN_ROLE_ID]), true],
    ["task.edit", actorWith([], true), true],
    ["task.assign", actorWith([]), false],
    ["task.done", actorWith([]), true],
    ["config.change", actorWith([OFFICER_ROLE_ID]), false],
  ] as const)("%s", (action, actor, expected) => {
    expect(holdsTierFor(action, actor, config)).toBe(expected);
  });

  it("refuses with no config, or another guild's", () => {
    const actor = actorWith([OFFICER_ROLE_ID], true);
    expect(holdsTierFor("task.done", actor, null)).toBe(false);
    expect(holdsTierFor("task.done", actor, undefined)).toBe(false);
    expect(
      holdsTierFor("task.done", actor, { ...config, guild_id: "5".repeat(18) }),
    ).toBe(false);
  });

  it("refuses a name that is no action", () => {
    expect(
      holdsTierFor("constructor" as "ping", actorWith([], true), config),
    ).toBe(false);
  });
});

describe("the event workflow roles", () => {
  it("gives the E-board role officer rights, and not admin rights", () => {
    expect(isOfficer(EBOARD, CONFIG)).toBe(true);
    expect(authorize("event.create", EBOARD, CONFIG).allowed).toBe(true);
    expect(authorize("task.edit", EBOARD, CONFIG, OTHERS_TASK).allowed).toBe(
      true,
    );
    expect(authorize("config.view", EBOARD, CONFIG)).toBe(REFUSED);
    expect(authorize("setup", EBOARD, CONFIG)).toBe(REFUSED);
  });

  it("gives the Treasury role budget approval and nothing an officer has", () => {
    expect(canApproveBudget(TREASURY, CONFIG)).toBe(true);
    expect(isOfficer(TREASURY, CONFIG)).toBe(false);
    expect(authorize("event.create", TREASURY, CONFIG)).toBe(REFUSED);
    expect(authorize("task.assign", TREASURY, CONFIG, EVENT)).toBe(REFUSED);
  });

  it.each([
    ["a member", MEMBER, false],
    ["Events Directors", OFFICER, true],
    ["E-board", EBOARD, true],
    ["Treasury", TREASURY, true],
    ["admin_role_id", ADMIN, true],
    ["the Administrator bit", ADMINISTRATOR, true],
  ] as const)("budget approval for %s is %s", (_label, who, expected) => {
    expect(canApproveBudget(who, CONFIG)).toBe(expected);
  });

  it("grants nothing for a role that is not set up", () => {
    const unset = { ...CONFIG, eboard_role_id: null, treasury_role_id: null };
    expect(isOfficer(EBOARD, unset)).toBe(false);
    expect(canApproveBudget(TREASURY, unset)).toBe(false);
    expect(canApproveBudget(OFFICER, unset)).toBe(true);
  });

  it("never counts an E-board or Treasury role bound to @everyone", () => {
    const everyone = actor({ roleIds: new Set([GUILD]) });
    const bound = { ...CONFIG, eboard_role_id: GUILD, treasury_role_id: GUILD };
    expect(isOfficer(everyone, bound)).toBe(false);
    expect(canApproveBudget(everyone, bound)).toBe(false);
  });

  it("refuses with no config, or another guild's", () => {
    for (const check of [
      (config: AuthorizationConfig | null) =>
        canApproveBudget(TREASURY, config),
      (config: AuthorizationConfig | null) =>
        canCompleteStep(OFFICER, config, [USER]),
    ]) {
      expect(check(null)).toBe(false);
      expect(check({ ...CONFIG, guild_id: OTHER_GUILD })).toBe(false);
    }
  });

  it("lets an assignee or the officer tier complete a step, and no one else", () => {
    expect(canCompleteStep(MEMBER, CONFIG, [USER])).toBe(true);
    expect(canCompleteStep(MEMBER, CONFIG, [OTHER_USER])).toBe(false);
    expect(canCompleteStep(MEMBER, CONFIG, [])).toBe(false);
    expect(canCompleteStep(TREASURY, CONFIG, [])).toBe(false);
    expect(canCompleteStep(EBOARD, CONFIG, [])).toBe(true);
    expect(canCompleteStep(OFFICER, CONFIG, [])).toBe(true);
    expect(canCompleteStep(ADMINISTRATOR, CONFIG, [])).toBe(true);
  });
});
