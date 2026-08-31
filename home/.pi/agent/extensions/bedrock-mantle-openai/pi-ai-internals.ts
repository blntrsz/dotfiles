/**
 * Loader for pi-ai internals that are shipped in the published package but not
 * re-exported from its public entrypoint.
 *
 * `@earendil-works/pi-ai` is not resolvable from an extension: pi's bundled CLI
 * hands extensions a *virtual* module for that specifier, so neither
 * `import.meta.resolve` nor `createRequire` can turn it into a path. And pi-ai's
 * `exports` map does not expose `./api/*` on the real package either.
 *
 * We therefore locate pi's own install from its entry script and load sibling
 * modules directly out of that `dist/` directory. This deliberately reuses pi's
 * *own* copy of pi-ai rather than a second copy in this extension's
 * node_modules, so these internals stay version-matched to the pi we run under.
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Subset of `dist/api/openai-responses-shared.js` used by this provider. */
export interface OpenAIResponsesSharedModule {
	convertResponsesMessages: (
		model: unknown,
		context: unknown,
		allowedToolCallProviders: ReadonlySet<string>,
		options?: unknown,
	) => unknown;
	convertResponsesTools: (tools: readonly unknown[], options?: unknown) => unknown[];
	processResponsesStream: (
		openaiStream: AsyncIterable<unknown>,
		output: unknown,
		stream: unknown,
		model: unknown,
		options?: unknown,
	) => Promise<void>;
}

/** Subset of `dist/api/simple-options.js`. */
export interface SimpleOptionsModule {
	buildBaseOptions: (model: unknown, context: unknown, options?: unknown, apiKey?: string) => Record<string, unknown>;
}

/** Subset of `dist/utils/provider-env.js`. */
export interface ProviderEnvModule {
	getProviderEnvValue: (name: string, env?: Record<string, string>) => string | undefined;
}

/** Subset of `dist/utils/headers.js`. */
export interface HeadersModule {
	headersToRecord: (headers: Headers) => Record<string, string>;
}

/** Marker file used to confirm a candidate directory really is pi-ai's dist/. */
const DIST_MARKER = "api/openai-responses-shared.js";

let distBaseUrl: URL | undefined;

/** Candidate pi-ai `dist/` locations relative to a directory on pi's entry path. */
function distCandidates(dir: string): string[] {
	return [
		// Published install: .../pi-coding-agent/node_modules/@earendil-works/pi-ai/dist
		join(dir, "node_modules/@earendil-works/pi-ai/dist"),
		// Hoisted install: .../node_modules/@earendil-works/pi-ai/dist
		join(dir, "@earendil-works/pi-ai/dist"),
		// Monorepo checkout: .../packages/ai/dist
		join(dir, "ai/dist"),
	];
}

/**
 * Locate the `dist/` directory of the pi-ai copy that the host pi process uses.
 *
 * pi's entry script lives inside its own install, so walking up from there finds
 * the pi-ai copy pi itself loaded — whether pi was installed from npm, hoisted
 * into a shared node_modules, or run from a monorepo checkout.
 */
function getPiAiDistBaseUrl(): URL {
	if (distBaseUrl) return distBaseUrl;

	const searchRoots = new Set<string>();
	for (const entry of [process.argv[1], import.meta.filename]) {
		if (!entry) continue;
		try {
			searchRoots.add(dirname(realpathSync(entry)));
		} catch {
			// Entry may be a shim that no longer exists; other roots still apply.
		}
	}
	// `pi-coding-agent` lists pi-ai as a dependency, so its manifest also anchors
	// the search on hosts where the entry path is opaque (SEA, bundled binaries).
	try {
		searchRoots.add(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {
		// Not resolvable under pi's virtual-module loader; expected.
	}

	for (const root of searchRoots) {
		let dir = root;
		for (let depth = 0; depth < 8; depth++) {
			for (const candidate of distCandidates(dir)) {
				if (existsSync(join(candidate, DIST_MARKER))) {
					distBaseUrl = pathToFileURL(`${candidate}/`);
					return distBaseUrl;
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	throw new Error(
		`Could not locate pi-ai's dist/ directory from [${[...searchRoots].join(", ")}]. ` +
			"This extension depends on pi-ai internals and may need updating for this pi version.",
	);
}

async function loadPiAiInternal<T>(relativePath: string, bareSpecifier: string): Promise<T> {
	const failures: string[] = [];

	try {
		return (await import(new URL(relativePath, getPiAiDistBaseUrl()).href)) as T;
	} catch (error) {
		failures.push(`via pi's pi-ai dist: ${(error as Error).message}`);
	}

	// Fallback for hosts that expose real package subpath exports.
	try {
		return (await import(bareSpecifier)) as T;
	} catch (error) {
		failures.push(`via bare specifier '${bareSpecifier}': ${(error as Error).message}`);
	}

	throw new Error(`Failed to load pi-ai internal '${relativePath}'.\n${failures.join("\n")}`);
}

export const loadOpenAIResponsesShared = (): Promise<OpenAIResponsesSharedModule> =>
	loadPiAiInternal<OpenAIResponsesSharedModule>(
		"api/openai-responses-shared.js",
		"@earendil-works/pi-ai/api/openai-responses-shared",
	);

export const loadSimpleOptions = (): Promise<SimpleOptionsModule> =>
	loadPiAiInternal<SimpleOptionsModule>("api/simple-options.js", "@earendil-works/pi-ai/api/simple-options");

export const loadProviderEnv = (): Promise<ProviderEnvModule> =>
	loadPiAiInternal<ProviderEnvModule>("utils/provider-env.js", "@earendil-works/pi-ai/utils/provider-env");

export const loadHeaders = (): Promise<HeadersModule> =>
	loadPiAiInternal<HeadersModule>("utils/headers.js", "@earendil-works/pi-ai/utils/headers");
