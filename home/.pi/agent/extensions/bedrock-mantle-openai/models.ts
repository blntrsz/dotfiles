/**
 * Bedrock Mantle model catalog.
 *
 * In pi#6216 these entries are generated at build time from models.dev by
 * `scripts/generate-models.ts` (selecting `provider.shape === "responses"` with
 * a `bedrock-mantle` + `/openai/` API URL). An extension has no build step, so
 * the generator's output is inlined here.
 *
 * Costs/limits come from models.dev's `amazon-bedrock` entries. Thinking-level
 * maps mirror pi's own OpenAI GPT-5.x models, which is exactly what the PR's
 * generator rule does ("mirror the OpenAI gpt-5.5 thinking levels"): `off` is
 * expressed as `none`, `minimal` is unsupported, `xhigh` is supported, and
 * `max` is GPT-5.6-only.
 */

/** `${AWS_REGION}` is materialized per request by resolveBedrockMantleEndpoint(). */
export const BEDROCK_MANTLE_BASE_URL = "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1";

export const BEDROCK_MANTLE_API = "amazon-bedrock-mantle-openai-responses";
export const BEDROCK_MANTLE_PROVIDER_ID = "amazon-bedrock-mantle-openai-responses";

const GPT_5_THINKING_LEVELS = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
} as const;

const GPT_5_6_THINKING_LEVELS = { ...GPT_5_THINKING_LEVELS, max: "max" } as const;

export interface MantleModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap: Record<string, string | null>;
}

export const BEDROCK_MANTLE_MODELS: MantleModelSpec[] = [
	{
		id: "openai.gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { ...GPT_5_6_THINKING_LEVELS },
	},
	{
		id: "openai.gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { ...GPT_5_6_THINKING_LEVELS },
	},
	{
		id: "openai.gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { ...GPT_5_6_THINKING_LEVELS },
	},
	{
		id: "openai.gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { ...GPT_5_THINKING_LEVELS },
	},
	{
		id: "openai.gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.75, output: 16.5, cacheRead: 0.275, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { ...GPT_5_THINKING_LEVELS },
	},
	// models.dev also lists xai.grok-4.3 on the same `/openai/v1` Mantle surface.
	// PR #6216 ships OpenAI models only; add it here if you want it too:
	// {
	//   id: "xai.grok-4.3", name: "Grok 4.3", reasoning: true, input: ["text", "image"],
	//   cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
	//   contextWindow: 1000000, maxTokens: 131072,
	//   thinkingLevelMap: { ...GPT_5_THINKING_LEVELS },
	// },
];
