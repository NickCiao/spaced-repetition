import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { CreateModel } from "./types";

let override: CreateModel | null = null;

/**
 * Test hook: replace the real provider with a factory returning a mock model
 * (e.g. `new MockLanguageModelV4({...})` from "ai/test"). Pass null to restore.
 * Production code never sets this.
 */
export function __setModelOverride(fn: CreateModel | null): void {
  override = fn;
}

/** Build the AI SDK model for a resolved config. Honors the test override when set. */
export const createModel: CreateModel = (config) => {
  if (override) return override(config);
  if (config.provider === "openai") return createOpenAI({ apiKey: config.apiKey })(config.model);
  return createAnthropic({ apiKey: config.apiKey })(config.model);
};
