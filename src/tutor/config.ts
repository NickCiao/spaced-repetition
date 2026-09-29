import { TUTOR_DEFAULT_MODEL, type GetTutorConfig, type TutorProvider } from "./types";

const SETTING_KEYS = ["tutor_provider", "tutor_model", "anthropic_api_key", "openai_api_key"] as const;

function asProvider(value: string | undefined): TutorProvider {
  const v = (value ?? "").trim();
  return v === "openai" ? "openai" : "anthropic";
}

/**
 * Resolve provider / model / key from the four `settings` rows. Provider falls back to
 * `anthropic` when unset or unrecognised; model falls back to the provider default.
 * Returns null when the active provider has no key — the caller shows "configure in Settings".
 */
export const getTutorConfig: GetTutorConfig = async (db) => {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)"
  ).bind(...SETTING_KEYS).all<{ key: string; value: string }>();
  const map = new Map(rows.results.map(r => [r.key, r.value]));

  const provider = asProvider(map.get("tutor_provider"));
  const model = (map.get("tutor_model") ?? "").trim() || TUTOR_DEFAULT_MODEL[provider];
  const apiKey = (map.get(provider === "openai" ? "openai_api_key" : "anthropic_api_key") ?? "").trim();
  if (!apiKey) return null;
  return { provider, model, apiKey };
};
