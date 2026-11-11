import { describe, expect, it } from "vitest";
import { ConfigError } from "./config-error.ts";

describe("ConfigError", () => {
  it("names the setting and the reason", () => {
    const error = new ConfigError("EXAMPLE_SETTING", "must not be empty");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConfigError");
    expect(error.setting).toBe("EXAMPLE_SETTING");
    expect(error.message).toBe(
      "Invalid configuration for EXAMPLE_SETTING: must not be empty",
    );
  });
});
