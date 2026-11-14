import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { describe, expect, it } from "bun:test";
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
  it("maps each action to its tier, and nothing else", () => {
    expect(new Map(COMMAND_POLICY)).toEqual(EXPECTED_POLICY);
  });

  it("refuses an object-scoped action with no row, even for the highest tier", () => {
    for (const action of actionsInScope("event", "task")) {
      expect(decide(action, ADMINISTRATOR, CONFIG)).toBe(REFUSED);
    }
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
});

describe("the public tier", () => {
  it("refuses at load a public action with a scope", () => {
    expect(() => {
      assertPublicRowsUnscoped([["x", "public", "event"]]);
    }).toThrow("must have scope none");
    expect(() => {
      assertPublicRowsUnscoped([
        ["x", "public", "none"],
        ["y", "officer", "event"],
      ]);
    }).not.toThrow();
  });

  // /ping reveals nothing, and has to work before setup so that a new deployment
  // can be checked.
  it("allows only ping before setup, for a member", () => {
    const allowed = [...COMMAND_POLICY.keys()].filter(
      (action) => decide(action as Action, MEMBER, null).allowed,
    );

    expect(allowed).toEqual(["ping"]);
  });
});

describe("unmapped actions", () => {
  it.each([
    "constructor",
    "__proto__",
    "",
    "EVENT.CREATE",
    "event.close:autocomplete",
  ])("refuses %j for every kind of actor", (action) => {
    expect(isAction(action)).toBe(false);
    for (const who of EVERY_KIND) {
      expect(decide(action, who, CONFIG, OWN_TASK)).toBe(REFUSED);
      expect(decide(action, who, null, OWN_TASK)).toBe(REFUSED);
    }
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

  // One action per tier. task.done has its own tests, because being the assignee
  // matters there.
  it.each([
    ["ping", "public"],
    ["mytasks", "self"],
    ["event.close", "officer"],
    ["event.approve_budget", "budget"],
    ["config.change", "admin"],
    ["setup", "bindings"],
  ] as const)("%s allows only tier %s", (action, tier) => {
    for (const who of EVERY_KIND) {
      expect(decide(action, who, CONFIG, rowFor(action)).allowed).toBe(
        allowedBy[tier].includes(who),
      );
    }
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
});

describe("another guild's config", () => {
  it("refuses every action, whatever the actor holds", () => {
    const foreign: AuthorizationConfig = { ...CONFIG, guild_id: OTHER_GUILD };
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
  it.each([...EVENT_SCOPED, ...OFFICER_TASK_SCOPED])(
    "%s needs an officer and a live row in the guild",
    (action) => {
      expect(decide(action, OFFICER, CONFIG, OTHERS_TASK).allowed).toBe(true);
      expect(decide(action, MEMBER, CONFIG, OWN_TASK)).toBe(REFUSED);
      expect(decide(action, OFFICER, CONFIG, null)).toBe(REFUSED);
      expect(
        decide(action, OFFICER, CONFIG, {
          ...OTHERS_TASK,
          guild_id: OTHER_GUILD,
        }),
      ).toBe(REFUSED);
      expect(
        decide(action, OFFICER, CONFIG, {
          ...OTHERS_TASK,
          deleted_at: DELETED_AT,
        }),
      ).toBe(REFUSED);
      const incomplete = { guild_id: GUILD } as EventResource;
      expect(decide(action, OFFICER, CONFIG, incomplete)).toBe(REFUSED);
    },
  );

  it("lets task.done through for the assignee or the officer tier", () => {
    expect(authorize("task.done", MEMBER, CONFIG, OWN_TASK).allowed).toBe(true);
    for (const who of [OFFICER, ADMIN, ADMINISTRATOR]) {
      expect(authorize("task.done", who, CONFIG, OTHERS_TASK).allowed).toBe(
        true,
      );
    }
    expect(authorize("task.done", MEMBER, CONFIG, OTHERS_TASK)).toBe(REFUSED);
    expect(authorize("task.done", OFFICER, CONFIG, null)).toBe(REFUSED);
    expect(
      authorize("task.done", MEMBER, CONFIG, {
        ...OWN_TASK,
        guild_id: OTHER_GUILD,
      }),
    ).toBe(REFUSED);
    expect(
      authorize("task.done", MEMBER, CONFIG, {
        ...OWN_TASK,
        deleted_at: DELETED_AT,
      }),
    ).toBe(REFUSED);
    expect(decide("task.done", MEMBER, CONFIG, EVENT)).toBe(REFUSED);
  });

  it("requires the row by type", () => {
    // @ts-expect-error an object-scoped action cannot leave out its row
    expect(authorize("event.close", OFFICER, CONFIG)).toBe(REFUSED);
    // @ts-expect-error task.done needs a task row, with its assignee
    expect(authorize("task.done", MEMBER, CONFIG, EVENT)).toBe(REFUSED);
    // @ts-expect-error an action with no object takes no row
    expect(authorize("mytasks", MEMBER, CONFIG, OWN_TASK).allowed).toBe(true);
    // @ts-expect-error event.link has no existing row to check
    expect(authorize("event.link", OFFICER, CONFIG, EVENT).allowed).toBe(true);
  });
});

describe("the event workflow", () => {
  it.each([
    ["a member", MEMBER, false],
    ["Events Directors", OFFICER, true],
    ["Treasury", TREASURY, true],
    ["the Administrator bit", ADMINISTRATOR, true],
  ] as const)("budget approval for %s is %s", (_label, who, expected) => {
    expect(canApproveBudget(who, CONFIG)).toBe(expected);
  });

  it("lets an assignee or the officer tier complete a step, and no one else", () => {
    // Anyone in a set-up guild gets past the gate. canCompleteStep decides.
    expect(authorize("event.step_done", MEMBER, CONFIG).allowed).toBe(true);
    expect(canCompleteStep(MEMBER, CONFIG, [USER])).toBe(true);
    expect(canCompleteStep(MEMBER, CONFIG, [OTHER_USER])).toBe(false);
    expect(canCompleteStep(TREASURY, CONFIG, [])).toBe(false);
    expect(canCompleteStep(EBOARD, CONFIG, [])).toBe(true);
  });

  it("refuses with no config, or another guild's", () => {
    for (const check of [
      (config: AuthorizationConfig | null) =>
        canApproveBudget(TREASURY, config),
      (config: AuthorizationConfig | null) =>
        canCompleteStep(OFFICER, config, [USER]),
      (config: AuthorizationConfig | null) => isOfficer(ADMINISTRATOR, config),
      (config: AuthorizationConfig | null) =>
        holdsTierFor("task.done", ADMINISTRATOR, config),
    ]) {
      expect(check(null)).toBe(false);
      expect(check({ ...CONFIG, guild_id: OTHER_GUILD })).toBe(false);
    }
  });
});

describe("autocompleteScope", () => {
  it("lists the guild for officers and refuses a member", () => {
    for (const who of [OFFICER, ADMINISTRATOR]) {
      expect(autocompleteScope("event.close", who, CONFIG)).toEqual({
        guildId: GUILD,
      });
      expect(autocompleteScope("task.done", who, CONFIG)).toEqual({
        guildId: GUILD,
      });
    }
    expect(autocompleteScope("event.close", MEMBER, CONFIG)).toBeUndefined();
  });

  it("limits task.done to a member's own tasks", () => {
    expect(autocompleteScope("task.done", MEMBER, CONFIG)).toEqual({
      guildId: GUILD,
      assigneeId: USER,
    });
  });

  it.each(["mytasks", "constructor", "event.close:autocomplete"])(
    "refuses %j, which has no autocomplete option",
    (command) => {
      expect(isAutocompleteCommand(command)).toBe(false);
      expect(
        autocompleteScope(
          command as AutocompleteCommand,
          ADMINISTRATOR,
          CONFIG,
        ),
      ).toBeUndefined();
    },
  );
});

describe("a bound role that equals the guild ID", () => {
  const holdsGuildId = actor({ roleIds: new Set([GUILD]) });
  const allBound = {
    ...CONFIG,
    officer_role_id: GUILD,
    admin_role_id: GUILD,
    eboard_role_id: GUILD,
    treasury_role_id: GUILD,
  };

  it("does not give anyone a tier", () => {
    expect(isOfficer(holdsGuildId, allBound)).toBe(false);
    expect(canApproveBudget(holdsGuildId, allBound)).toBe(false);
    expect(authorize("config.view", holdsGuildId, allBound)).toBe(REFUSED);
    expect(
      autocompleteScope("event.close", holdsGuildId, allBound),
    ).toBeUndefined();
  });
});

describe("the refusal", () => {
  it("is one frozen object for every cause", () => {
    const causes = [
      decide("constructor", MEMBER, CONFIG),
      decide("event.create", MEMBER, CONFIG),
      decide("mytasks", MEMBER, null),
      decide("task.done", MEMBER, CONFIG, OTHERS_TASK),
      decide("mytasks", MEMBER, { ...CONFIG, guild_id: OTHER_GUILD }),
    ];

    expect(causes.every((decision) => decision === REFUSED)).toBe(true);
    expect(REFUSED.allowed).toBe(false);
    expect(Object.isFrozen(REFUSED)).toBe(true);
    expect(Object.isFrozen(authorize("mytasks", MEMBER, CONFIG))).toBe(true);
  });
});

describe("holdsTierFor", () => {
  it.each([
    ["task.edit", MEMBER, false],
    ["task.edit", OFFICER, true],
    ["task.done", MEMBER, true],
    ["config.change", OFFICER, false],
  ] as const)("%s", (action, who, expected) => {
    expect(holdsTierFor(action, who, CONFIG)).toBe(expected);
  });
});
