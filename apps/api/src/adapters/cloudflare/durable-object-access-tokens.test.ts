import { describe, expect, it } from "vite-plus/test";

import { VALID_TOKEN_RESPONSE } from "../../__tests__/fixtures/spotify";
import { LoggingTracer } from "../../capabilities/tracer";
import { logger } from "../../lib/logger";
import { DurableObjectSpotifyAccessTokens } from "./durable-object-access-tokens";

import type { SpotifyTokenResponse } from "../../services/spotify-service";
import type { TokenRpcNamespace, TokenRpcWireResult } from "./durable-object-access-tokens";

interface ColdTokenNamespace {
	readonly namespace: TokenRpcNamespace<SpotifyTokenResponse>;
	readonly initializedName: () => string | null;
}

function createColdTokenNamespace(): ColdTokenNamespace {
	let initializedName: string | null = null;
	const requireInitializedName = (): void => {
		if (initializedName === null) throw new Error("Agent name was not initialized");
	};
	const lifecycleResult = async (): Promise<TokenRpcWireResult<void>> => {
		requireInitializedName();
		return { status: "ok", value: undefined };
	};
	const stub = {
		async setName(name: string): Promise<void> {
			initializedName = name;
		},
		async getValidToken(): Promise<TokenRpcWireResult<string>> {
			requireInitializedName();
			return { status: "ok", value: "access-token" };
		},
		setTokens: lifecycleResult,
		onStreamOnline: lifecycleResult,
		onStreamOffline: lifecycleResult,
	};
	return {
		namespace: { getByName: () => stub },
		initializedName: () => initializedName,
	};
}

describe("DurableObjectSpotifyAccessTokens Agent initialization", () => {
	it("initializes a cold Agent before reading its access token", async () => {
		const cold = createColdTokenNamespace();
		const tokens = new DurableObjectSpotifyAccessTokens(cold.namespace, new LoggingTracer(logger));

		const result = await tokens.getValidAccessToken();

		expect(result.status).toBe("ok");
		expect(cold.initializedName()).toBe("spotify-token");
	});

	it("initializes a cold Agent before persisting OAuth tokens", async () => {
		const cold = createColdTokenNamespace();
		const tokens = new DurableObjectSpotifyAccessTokens(cold.namespace, new LoggingTracer(logger));

		const result = await tokens.setTokens({
			...VALID_TOKEN_RESPONSE,
			refresh_token: VALID_TOKEN_RESPONSE.refresh_token ?? "refresh-token",
		});

		expect(result.status).toBe("ok");
		expect(cold.initializedName()).toBe("spotify-token");
	});
});
