import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { exportableSettings, getSettings, setSetting } from "../src/db";
import { AUTH, AUTH_HEADERS } from "./helpers";

const POST = (path: string, body: unknown) =>
  exports.default.fetch(`http://sr${path}`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

/** Same valid-body shape as the existing settings tests. */
const VALID = {
  session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/New_York",
  email_to: "", base_url: ""
};

const TUTOR_KEYS = ["tutor_provider", "tutor_model", "anthropic_api_key", "openai_api_key"];

describe("tutor settings", () => {
  beforeEach(async () => {
    for (const k of TUTOR_KEYS) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(k).run();
  });

  it("GET /settings renders the Tutor section without echoing stored keys", async () => {
    await setSetting(env.DB, "anthropic_api_key", "sk-ant-literal-secret-value");
    await setSetting(env.DB, "openai_api_key", "sk-openai-literal-secret-value");
    const res = await exports.default.fetch("http://sr/settings", AUTH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h6 class="kicker">Tutor</h6>');
    expect(html).toContain('id="tutor_provider"');
    expect(html).toContain('id="tutor_model"');
    expect(html).toContain('id="anthropic_api_key"');
    expect(html).toContain('id="openai_api_key"');
    expect(html).toContain('id="clear-anthropic" >');
    expect(html).toContain('id="clear-openai" >');
    expect(html).not.toContain("sk-ant-literal-secret-value");
    expect(html).not.toContain("sk-openai-literal-secret-value");
  });

  it("defaults: anthropic provider, empty model, no keys, clear buttons hidden", async () => {
    const s = await getSettings(env.DB);
    expect(s.tutor_provider).toBe("anthropic");
    expect(s.tutor_model).toBe("");
    expect(s.anthropic_key_set).toBe(false);
    expect(s.openai_key_set).toBe(false);
    const html = await (await exports.default.fetch("http://sr/settings", AUTH)).text();
    expect(html).toContain('id="clear-anthropic" hidden');
    expect(html).toContain('id="clear-openai" hidden');
    expect(html).toContain('id="tutor_model" value="" placeholder="claude-opus-5-5"');
  });

  it("POST /api/settings stores provider, trimmed model, and key", async () => {
    const res = await POST("/api/settings", {
      ...VALID, tutor_provider: "openai", tutor_model: " gpt-6-sol ", openai_api_key: "sk-test"
    });
    expect(res.status).toBe(200);
    const s = await getSettings(env.DB);
    expect(s.tutor_provider).toBe("openai");
    expect(s.tutor_model).toBe("gpt-6-sol");
    expect(s.openai_key_set).toBe(true);
    expect(s.anthropic_key_set).toBe(false);
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").first<{ value: string }>();
    expect(row?.value).toBe("sk-test");
    // Page reflects the selection and the openai default as placeholder, never the key.
    const html = await (await exports.default.fetch("http://sr/settings", AUTH)).text();
    expect(html).toContain('<option value="openai" data-default-model="gpt-6-astra" selected>');
    expect(html).toContain('id="tutor_model" value="gpt-6-sol" placeholder="gpt-6-astra"');
    expect(html).not.toContain("sk-test");
  });

  it("blank key keeps the existing one; non-blank replaces it", async () => {
    expect((await POST("/api/settings", { ...VALID, anthropic_api_key: "sk-ant-one" })).status).toBe(200);
    expect((await POST("/api/settings", { ...VALID, anthropic_api_key: "   " })).status).toBe(200);
    let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").first<{ value: string }>();
    expect(row?.value).toBe("sk-ant-one");
    expect((await POST("/api/settings", { ...VALID, anthropic_api_key: " sk-ant-two " })).status).toBe(200);
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").first<{ value: string }>();
    expect(row?.value).toBe("sk-ant-two");
  });

  it("invalid provider is a 400 and nothing is written", async () => {
    const res = await POST("/api/settings", { ...VALID, tutor_provider: "gemini" });
    expect(res.status).toBe(400);
    expect((await POST("/api/settings", { ...VALID, tutor_provider: 42 })).status).toBe(400);
    expect((await getSettings(env.DB)).tutor_provider).toBe("anthropic");
  });

  it("invalid provider value stored in D1 falls back to anthropic", async () => {
    await setSetting(env.DB, "tutor_provider", "bogus");
    expect((await getSettings(env.DB)).tutor_provider).toBe("anthropic");
  });

  it("tutor_model over 100 chars is a 400; empty is allowed", async () => {
    expect((await POST("/api/settings", { ...VALID, tutor_model: "x".repeat(101) })).status).toBe(400);
    expect((await POST("/api/settings", { ...VALID, tutor_model: "x".repeat(100) })).status).toBe(200);
    expect((await POST("/api/settings", { ...VALID, tutor_model: "" })).status).toBe(200);
    expect((await getSettings(env.DB)).tutor_model).toBe("");
  });

  it("clear flags blank the keys", async () => {
    await POST("/api/settings", { ...VALID, openai_api_key: "sk-test", anthropic_api_key: "sk-ant-test" });
    expect((await getSettings(env.DB)).openai_key_set).toBe(true);
    const res = await POST("/api/settings", { ...VALID, clear_openai_api_key: true });
    expect(res.status).toBe(200);
    let s = await getSettings(env.DB);
    expect(s.openai_key_set).toBe(false);
    expect(s.anthropic_key_set).toBe(true);
    await POST("/api/settings", { ...VALID, clear_anthropic_api_key: true });
    s = await getSettings(env.DB);
    expect(s.anthropic_key_set).toBe(false);
  });

  it("omitting tutor fields leaves them untouched (existing clients keep working)", async () => {
    await POST("/api/settings", { ...VALID, tutor_provider: "openai", tutor_model: "m", openai_api_key: "sk-test" });
    expect((await POST("/api/settings", VALID)).status).toBe(200);
    const s = await getSettings(env.DB);
    expect(s.tutor_provider).toBe("openai");
    expect(s.tutor_model).toBe("m");
    expect(s.openai_key_set).toBe(true);
  });

  it("exportableSettings never includes tutor settings or keys", async () => {
    await POST("/api/settings", {
      ...VALID, tutor_provider: "openai", tutor_model: "gpt-6-sol",
      openai_api_key: "sk-test", anthropic_api_key: "sk-ant-test"
    });
    const out = exportableSettings(await getSettings(env.DB));
    for (const k of [...TUTOR_KEYS, "anthropic_key_set", "openai_key_set"]) expect(out).not.toHaveProperty(k);
    expect(JSON.stringify(out)).not.toContain("sk-");
  });
});
