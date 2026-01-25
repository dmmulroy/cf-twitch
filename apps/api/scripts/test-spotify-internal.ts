/**
 * Ad-hoc script to test Spotify internal APIs
 *
 * Required env vars:
 *   SPOTIFY_ACCESS_TOKEN - Valid Spotify OAuth access token
 *   SPOTIFY_CLIENT_ID - Spotify app client ID
 *
 * Run: SPOTIFY_ACCESS_TOKEN=xxx SPOTIFY_CLIENT_ID=yyy npx tsx scripts/test-spotify-internal.ts
 */

/* oxlint-disable no-console -- test script */

import { z } from "zod";

// =============================================================================
// Zod Schemas (copied from spotify-service.ts for standalone use)
// =============================================================================

const SpotifyDeviceSchema = z.object({
	id: z.string(),
	is_active: z.boolean(),
	name: z.string(),
	type: z.string(),
});

const SpotifyDevicesResponseSchema = z.object({
	devices: z.array(SpotifyDeviceSchema),
});

const ClientTokenResponseSchema = z.object({
	granted_token: z.object({
		token: z.string(),
		expires_after_seconds: z.number(),
	}),
});

const ConnectStateTrackSchema = z.object({
	uri: z.string(),
	uid: z.string(),
	metadata: z.record(z.string(), z.string()),
	provider: z.string(),
});

const ConnectStatePlayerSchema = z.object({
	timestamp: z.string(),
	context_uri: z.string(),
	queue_revision: z.string(),
	next_tracks: z.array(ConnectStateTrackSchema),
	prev_tracks: z.array(ConnectStateTrackSchema),
});

const ConnectStateResponseSchema = z.object({
	player_state: ConnectStatePlayerSchema,
});

// =============================================================================
// Test Functions
// =============================================================================

async function getActiveDevice(accessToken: string) {
	console.log("\n📱 Testing getActiveDevice (official API)...");

	const response = await fetch("https://api.spotify.com/v1/me/player/devices", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (response.status === 401) {
		throw new Error("Unauthorized - token may be expired");
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}

	const json: unknown = await response.json();
	const parsed = SpotifyDevicesResponseSchema.safeParse(json);

	if (!parsed.success) {
		console.error("Parse error:", parsed.error.message);
		console.error("Raw response:", JSON.stringify(json, null, 2));
		throw new Error("Failed to parse devices response");
	}

	const activeDevice = parsed.data.devices.find((d) => d.is_active) ?? null;

	console.log("✅ Devices found:", parsed.data.devices.length);
	console.log(
		"   All devices:",
		parsed.data.devices.map((d) => `${d.name} (${d.type}, active=${d.is_active})`),
	);
	console.log(
		"   Active device:",
		activeDevice ? `${activeDevice.name} (${activeDevice.id})` : "none",
	);

	return activeDevice;
}

async function getClientToken(clientId: string) {
	console.log("\n🔑 Testing getClientToken (internal API)...");

	const response = await fetch("https://clienttoken.spotify.com/v1/clienttoken", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_data: {
				client_version: "1.2.52.442",
				client_id: clientId,
				js_sdk_data: {
					device_brand: "unknown",
					device_model: "desktop",
					os: "Linux",
					os_version: "unknown",
					device_id: crypto.randomUUID(),
					device_type: "computer",
				},
			},
		}),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}

	const json: unknown = await response.json();
	const parsed = ClientTokenResponseSchema.safeParse(json);

	if (!parsed.success) {
		console.error("Parse error:", parsed.error.message);
		// Never log raw response - contains token
		throw new Error("Failed to parse client token response");
	}

	const expiresIn = parsed.data.granted_token.expires_after_seconds;

	console.log("✅ Client token obtained");
	console.log("   Expires in:", expiresIn, "seconds");

	return parsed.data.granted_token.token;
}

async function getConnectState(deviceId: string, accessToken: string, clientToken: string) {
	console.log("\n🎵 Testing getConnectState (internal API)...");

	const response = await fetch(
		`https://gue1-spclient.spotify.com/connect-state/v1/devices/hobs_${deviceId}`,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"client-token": clientToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				member_type: "CONNECT_STATE",
				device: { device_info: { capabilities: { can_be_player: false } } },
			}),
		},
	);

	if (!response.ok) {
		const text = await response.text();
		console.error("Response:", text);
		throw new Error(`HTTP ${response.status}`);
	}

	const json: unknown = await response.json();
	const parsed = ConnectStateResponseSchema.safeParse(json);

	if (!parsed.success) {
		console.error("Parse error:", parsed.error.message);
		console.error("Raw response (truncated):", JSON.stringify(json, null, 2).substring(0, 2000));
		throw new Error("Failed to parse connect state response");
	}

	const state = parsed.data.player_state;

	console.log("✅ Connect state obtained");
	console.log("   Queue revision:", state.queue_revision);
	console.log("   Context URI:", state.context_uri);
	console.log("   Next tracks:", state.next_tracks.length);
	console.log("   Prev tracks:", state.prev_tracks.length);

	if (state.next_tracks.length > 0) {
		console.log("\n   📋 Queue (next tracks):");
		for (const track of state.next_tracks.slice(0, 5)) {
			const name = track.metadata["title"] ?? "Unknown";
			const artist = track.metadata["artist_name"] ?? "Unknown";
			console.log(`      - ${name} by ${artist}`);
			console.log(`        URI: ${track.uri}, UID: ${track.uid}`);
		}
		if (state.next_tracks.length > 5) {
			console.log(`      ... and ${state.next_tracks.length - 5} more`);
		}
	}

	return state;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
	const accessToken = process.env.SPOTIFY_ACCESS_TOKEN;
	const clientId = process.env.SPOTIFY_CLIENT_ID;

	if (!accessToken) {
		console.error("❌ Missing SPOTIFY_ACCESS_TOKEN env var");
		console.error("   Get one from: https://developer.spotify.com/console/get-users-profile/");
		process.exit(1);
	}

	if (!clientId) {
		console.error("❌ Missing SPOTIFY_CLIENT_ID env var");
		process.exit(1);
	}

	console.log("🧪 Spotify Internal API Test Script");
	console.log("===================================");

	try {
		// Test 1: Get active device (official API)
		const device = await getActiveDevice(accessToken);

		if (!device) {
			console.log("\n⚠️  No active device found. Please start playing something on Spotify.");
			console.log("   Cannot test internal APIs without an active device.");
			process.exit(0);
		}

		// Test 2: Get client token (internal API)
		const clientToken = await getClientToken(clientId);

		// Test 3: Get connect state (internal API)
		await getConnectState(device.id, accessToken, clientToken);

		console.log("\n✅ All tests passed!");
	} catch (error) {
		console.error("\n❌ Test failed:", error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

void main();
