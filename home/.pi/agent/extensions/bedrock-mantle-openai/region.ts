/**
 * Region/endpoint resolution for Amazon Bedrock Mantle.
 *
 * Faithful port of `packages/ai/src/api/amazon-bedrock-mantle-region.ts` from
 * earendil-works/pi#6216.
 */

const AWS_REGION_PLACEHOLDER = "${AWS_REGION}";
const DEFAULT_REGION = "us-east-1";

/**
 * Per-model region availability. The first region is the deterministic fallback
 * used when the caller's region does not offer the model.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html
 *
 * DEVIATION FROM UPSTREAM (pi#6216): AWS also serves these models in us-east-2,
 * but it is omitted deliberately. This org's service control policy explicitly
 * denies bedrock-mantle:CreateInference in us-east-2, so listing it would let an
 * ambient AWS_REGION=us-east-2 route there and fail with HTTP 401. Omitting it
 * makes such requests fall back to us-east-1 instead. Restore "us-east-2" here
 * if the SCP is ever relaxed.
 */
const MODEL_REGIONS: Record<string, readonly string[]> = {
	"openai.gpt-5.4": ["us-east-1", "us-west-2", "us-gov-west-1"],
	"openai.gpt-5.5": ["us-east-1"],
	"openai.gpt-5.6-sol": ["us-east-1"],
	"openai.gpt-5.6-terra": ["us-east-1", "us-west-2"],
	"openai.gpt-5.6-luna": ["us-east-1", "us-west-2"],
	"xai.grok-4.3": ["us-east-1", "us-west-2"],
};

function getStandardRegionFromHost(baseUrl: string): string | undefined {
	try {
		const { hostname } = new URL(baseUrl);
		return hostname.toLowerCase().match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/)?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Materialize the `${AWS_REGION}` placeholder in the Mantle base URL and return
 * the matching SigV4 signing region.
 *
 * An explicitly configured region wins only when the model is served there;
 * otherwise the model's primary region is used, so a caller sitting in
 * `us-west-2` still reaches `us-east-1`-only models.
 */
export function resolveBedrockMantleEndpoint(
	modelId: string,
	baseUrl: string,
	options?: { region?: string; env?: Record<string, string> },
	getEnvValue: (name: string, env?: Record<string, string>) => string | undefined = (name, env) =>
		env?.[name] || process.env[name] || undefined,
): { baseUrl: string; region: string | undefined } {
	// A fully-qualified endpoint pins its own region; never rewrite it.
	const endpointRegion = getStandardRegionFromHost(baseUrl);
	if (endpointRegion) return { baseUrl, region: endpointRegion };

	const requestedRegion =
		options?.region?.trim() ||
		getEnvValue("AWS_REGION", options?.env)?.trim() ||
		getEnvValue("AWS_DEFAULT_REGION", options?.env)?.trim() ||
		undefined;
	if (!baseUrl.includes(AWS_REGION_PLACEHOLDER)) return { baseUrl, region: requestedRegion };

	const supportedRegions = MODEL_REGIONS[modelId];
	const region =
		requestedRegion && (!supportedRegions || supportedRegions.includes(requestedRegion))
			? requestedRegion
			: (supportedRegions?.[0] ?? requestedRegion ?? DEFAULT_REGION);
	return { baseUrl: baseUrl.replaceAll(AWS_REGION_PLACEHOLDER, region), region };
}
