import Anthropic from "@anthropic-ai/sdk";

export const GLM_MODEL = process.env.GLM_MODEL ?? "glm-5.2";

/** GLM-5.2 exposes an Anthropic-compatible Messages API on api.z.ai. */
export function glmClient(apiKey?: string): Anthropic {
  const key = apiKey ?? process.env.GLM_API_KEY;
  if (!key) throw new Error("GLM_API_KEY is not configured");
  return new Anthropic({
    apiKey: key,
    baseURL: process.env.GLM_BASE_URL ?? "https://api.z.ai/api/anthropic",
  });
}

// GLM's thinking eats the whole output budget if max_tokens is small: keep
// max_tokens comfortably above the thinking budget.
export const GLM_MAX_TOKENS = 64000;
export const GLM_THINKING_BUDGET = 8000;
