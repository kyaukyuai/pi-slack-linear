import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config.js";

const baseEnv = {
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_ALLOWED_CHANNEL_IDS: "C0ALAMDRB9V",
  LINEAR_API_KEY: "lin_api_test",
  LINEAR_WORKSPACE: "kyaukyuai",
  LINEAR_TEAM_KEY: "AIC",
};

describe("loadConfig", () => {
  it("defaults webhook config to disabled", () => {
    const config = loadConfig(baseEnv);

    expect(config.linearWebhookEnabled).toBe(false);
    expect(config.linearWebhookPort).toBe(8787);
    expect(config.linearWebhookPath).toBe("/hooks/linear");
  });

  it("requires public URL and secret when webhook automation is enabled", () => {
    expect(() => loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: "true",
    })).toThrow();

    const config = loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: "true",
      LINEAR_WEBHOOK_PUBLIC_URL: "https://example.com",
      LINEAR_WEBHOOK_SECRET: "secret-1",
    });

    expect(config.linearWebhookEnabled).toBe(true);
    expect(config.linearWebhookPublicUrl).toBe("https://example.com");
    expect(config.linearWebhookSecret).toBe("secret-1");
  });
});
