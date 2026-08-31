/**
 * Amazon Bedrock Mantle OpenAI Responses provider for pi.
 *
 * Port of earendil-works/pi#6216 ("feat: Add Amazon Bedrock Mantle OpenAI
 * Responses provider") as a pi extension, so it works against a released pi
 * without rebuilding pi from source.
 *
 * Like the PR, requests go through the official `openai` SDK's Bedrock provider
 * (`openai/providers/bedrock/aws`), which signs with AWS SigV4 using the
 * standard credential chain (env vars, profile, SSO, container/ECS, web
 * identity), or uses a Bedrock bearer token when one is available.
 *
 * Usage:
 *   pi --provider amazon-bedrock-mantle-openai-responses --model openai.gpt-5.5
 */
import OpenAI from "openai";
import { type BedrockProviderOptions, bedrock } from "openai/providers/bedrock/aws";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { AssistantMessageEventStream, clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BEDROCK_MANTLE_API,
	BEDROCK_MANTLE_BASE_URL,
	BEDROCK_MANTLE_MODELS,
	BEDROCK_MANTLE_PROVIDER_ID,
} from "./models.ts";
import {
	loadHeaders,
	loadOpenAIResponsesShared,
	loadProviderEnv,
	loadSimpleOptions,
} from "./pi-ai-internals.ts";
import { resolveBedrockMantleEndpoint } from "./region.ts";

/** Providers whose tool-call ids remain valid when handing context to Mantle. */
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", BEDROCK_MANTLE_API]);
const MIN_OUTPUT_TOKENS = 16;

/**
 * Placeholder API key. pi requires a credential for a model-defining provider,
 * but SigV4 signing takes its credentials from the AWS chain instead. Treated
 * as "no bearer token" below.
 */
const SIGV4_SENTINEL = "aws-sigv4";

type AnyModel = {
	id: string;
	provider: string;
	baseUrl: string;
	maxTokens?: number;
	reasoning?: boolean;
	headers?: Record<string, string>;
	thinkingLevelMap?: Record<string, string | null>;
};

interface MantleStreamOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
	maxTokens?: number;
	temperature?: number;
	reasoning?: string;
	reasoningEffort?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	region?: string;
	profile?: string;
	baseUrl?: string;
	bearerToken?: string;
	onPayload?: (params: unknown, model: unknown) => unknown;
	onResponse?: (info: { status: number; headers: Record<string, string> }, model: unknown) => unknown;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `Amazon Bedrock Mantle OpenAI Responses API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

async function buildProviderOptions(model: AnyModel, options?: MantleStreamOptions): Promise<BedrockProviderOptions> {
	const { getProviderEnvValue } = await loadProviderEnv();

	const configuredBaseUrl = options?.baseUrl?.trim() || model.baseUrl.trim();
	const { baseUrl, region } = resolveBedrockMantleEndpoint(
		model.id,
		configuredBaseUrl,
		options,
		getProviderEnvValue,
	);
	const endpoint: BedrockProviderOptions = {
		...(region ? { region } : {}),
		baseURL: baseUrl,
	};

	// Bearer and AWS credential modes are mutually exclusive in `bedrock()`; prefer
	// an explicit bearer token when present.
	const apiKey =
		options?.apiKey === "<authenticated>" || options?.apiKey === SIGV4_SENTINEL ? undefined : options?.apiKey;
	const bearerToken =
		options?.bearerToken || apiKey || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options?.env) || undefined;
	if (bearerToken) {
		return { ...endpoint, apiKey: bearerToken };
	}

	// `bedrock()` accepts exactly one explicit AWS mode, so prefer explicit static
	// credentials over a named profile (matching AWS SDK precedence) before falling
	// back to the default credential chain.
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", options?.env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", options?.env);
	if (accessKeyId && secretAccessKey) {
		const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", options?.env);
		return { ...endpoint, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
	}
	const profile = options?.profile || getProviderEnvValue("AWS_PROFILE", options?.env) || undefined;
	if (profile) {
		return { ...endpoint, profile };
	}
	return endpoint;
}

async function createClient(model: AnyModel, options: MantleStreamOptions | undefined): Promise<OpenAI> {
	const headers = { ...model.headers };
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	return new OpenAI({
		provider: bedrock(await buildProviderOptions(model, options)),
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

async function buildParams(
	model: AnyModel,
	context: unknown,
	options?: MantleStreamOptions,
): Promise<ResponseCreateParamsStreaming> {
	const { convertResponsesMessages, convertResponsesTools } = await loadOpenAIResponsesShared();
	const messages = convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS);

	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages as ResponseCreateParamsStreaming["input"],
		stream: true,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, MIN_OUTPUT_TOKENS);
	} else if (model.maxTokens) {
		// Bedrock Mantle can return an empty completed response when reasoning and
		// encrypted reasoning replay are requested without an output cap. Always send
		// a cap; the endpoint clamps it to available context.
		params.max_output_tokens = model.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	const tools = (context as { tools?: readonly unknown[] })?.tools;
	if (tools && tools.length > 0) {
		params.tools = convertResponsesTools(tools) as ResponseCreateParamsStreaming["tools"];
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}

/** Low-level stream: mirrors `stream()` in the PR's api module. */
function streamMantle(model: AnyModel, context: unknown, options?: MantleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = {
			role: "assistant" as const,
			content: [] as unknown[],
			api: BEDROCK_MANTLE_API,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending" as string,
			errorMessage: undefined as string | undefined,
			timestamp: Date.now(),
		};

		try {
			const { processResponsesStream } = await loadOpenAIResponsesShared();
			const { headersToRecord } = await loadHeaders();

			const client = await createClient(model, options);
			let params = await buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			const { data: openaiStream, response } = await client.responses.create(params, requestOptions).withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output } as never);

			await processResponsesStream(openaiStream as AsyncIterable<unknown>, output, stream, model);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "pending") {
				throw new Error("Amazon Bedrock Mantle stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output } as never);
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output } as never);
			stream.end();
		}
	})();

	return stream;
}

/** Entry point pi calls: mirrors `streamSimple()` in the PR's api module. */
function streamSimple(model: AnyModel, context: unknown, options?: MantleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		try {
			const { buildBaseOptions } = await loadSimpleOptions();
			const base = buildBaseOptions(model, context, options, options?.apiKey) as MantleStreamOptions;
			const clampedReasoning = options?.reasoning
				? (clampThinkingLevel(model as never, options.reasoning as never) as unknown as string)
				: undefined;
			const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

			const inner = streamMantle(model, context, { ...base, reasoningEffort });
			for await (const event of inner) {
				stream.push(event as never);
			}
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: BEDROCK_MANTLE_API,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: formatError(error),
					timestamp: Date.now(),
				},
			} as never);
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(BEDROCK_MANTLE_PROVIDER_ID, {
		name: "Amazon Bedrock Mantle",
		baseUrl: BEDROCK_MANTLE_BASE_URL,
		// Real credentials come from the AWS chain (or AWS_BEARER_TOKEN_BEDROCK)
		// inside buildProviderOptions(); this only satisfies pi's requirement that a
		// model-defining provider has a key.
		apiKey: SIGV4_SENTINEL,
		api: BEDROCK_MANTLE_API,
		streamSimple: streamSimple as never,
		models: BEDROCK_MANTLE_MODELS.map((model) => ({
			id: model.id,
			name: model.name,
			api: BEDROCK_MANTLE_API,
			baseUrl: BEDROCK_MANTLE_BASE_URL,
			reasoning: model.reasoning,
			thinkingLevelMap: model.thinkingLevelMap,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})) as never,
	} as never);
}
