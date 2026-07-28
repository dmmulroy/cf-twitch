import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { DurableObjectChatCommands } from "../../adapters/cloudflare/durable-object-chat-commands";
import { DurableObjectEventBusAdministration } from "../../adapters/cloudflare/durable-object-event-bus-administration";
import { DurableObjectAchievementReader } from "../../adapters/cloudflare/durable-object-http-state";
import { DurableObjectRaffleStatistics } from "../../adapters/cloudflare/durable-object-raffle-statistics";
import { DurableObjectSongQueue } from "../../adapters/cloudflare/durable-object-song-queue";
import { createAdminRoutes } from "../../adapters/http/create-admin-routes";
import { LoggingTracer } from "../../capabilities/tracer";
import { logger } from "../../lib/logger";
import { RedactedValue } from "../../lib/redacted";

const ADMIN_SECRET = "admin-command-test-secret";
const tracer = new LoggingTracer(logger);
const achievements = new DurableObjectAchievementReader(env.ACHIEVEMENTS_DO, tracer);
const admin = createAdminRoutes({
	administratorSecret: RedactedValue.fromSensitiveValue(ADMIN_SECRET),
	eventBus: new DurableObjectEventBusAdministration(env.EVENT_BUS_DO, tracer),
	achievements,
	chatCommands: new DurableObjectChatCommands(env.COMMANDS_DO, tracer),
	songQueue: new DurableObjectSongQueue(env.SONG_QUEUE_DO, tracer),
	raffles: new DurableObjectRaffleStatistics(env.KEYBOARD_RAFFLE_DO, tracer),
	logger,
});

function adminRequest(path: string, init: RequestInit): Promise<Response> {
	return admin.request(`http://localhost${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${ADMIN_SECRET}`,
			"content-type": "application/json",
			...init.headers,
		},
	});
}

describe("Admin Chat Command routes", () => {
	it("returns HTTP 409 with the precise duplicate command conflict", async () => {
		const response = await adminRequest("/commands", {
			method: "POST",
			body: JSON.stringify({
				name: "keyboard",
				description: "Duplicate keyboard command",
				category: "info",
				responseType: "static",
				permission: "everyone",
			}),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "CommandAlreadyExistsError" });
	});

	it("returns HTTP 400 for unknown, empty, and incomplete patches", async () => {
		const unknown = await adminRequest("/commands/keyboard", {
			method: "PATCH",
			body: JSON.stringify({ enable: false }),
		});
		expect(unknown.status).toBe(400);

		const empty = await adminRequest("/commands/keyboard", {
			method: "PATCH",
			body: JSON.stringify({}),
		});
		expect(empty.status).toBe(400);

		const incompleteTransition = await adminRequest("/commands/keyboard", {
			method: "PATCH",
			body: JSON.stringify({ responseType: "computed" }),
		});
		expect(incompleteTransition.status).toBe(400);
		expect(await incompleteTransition.json()).toMatchObject({
			code: "CommandInvalidDefinitionError",
		});
	});

	it("rejects an empty Viewer selector instead of performing a global Achievement reset", async () => {
		const response = await adminRequest("/achievements/reset-one-time?user=", {
			method: "POST",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Viewer display name must not be empty" });
	});
});
