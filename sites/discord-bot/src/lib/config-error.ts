/**
 * Thrown when a required setting is missing or malformed. The message names the
 * setting and never includes its value, because the value may be a secret and
 * this message may reach the logs.
 */
export class ConfigError extends Error {
  readonly setting: string;

  constructor(setting: string, reason: string) {
    super(`Invalid configuration for ${setting}: ${reason}`);
    this.name = "ConfigError";
    this.setting = setting;
  }
}
