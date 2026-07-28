import { describe, expect, it } from "vite-plus/test";

import { VALID_TOKEN_RESPONSE } from "../../__tests__/fixtures/spotify";
import { LoggingTracer } from "../../capabilities/tracer";
import { logger } from "../../lib/logger";
import { DurableObjectSpotifyAccessTokens } from "./durable-object-access-tokens";

function createColdTokenNamespace() {
	let initializedName: string | null = null;
	const stub = {
		async setName(name: string): Promise<void> {
			initializedName = name;
		},
		async getValidToken(): Promise<unknown> {
			if (initializedName === null) throw new Error("Agent name was not initialized");
			return { status: "ok", value: "access-token" };
		},
		async setTokens(): Promise<unknown> {
			if (initializedName === null) throw new Error("Agent name was not initialized");
			return { status: "ok", value: undefined };
		},
	};
	return {
		namespace: {
			getByName: () => stub,
		} as unknown as Cloudflare.Env["SPOTIFY_TOKEN_DO"],
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
