import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import admin from "../../routes/admin";

import type { Env } from "../../index";

const ADMIN_SECRET = "admin-command-test-secret";
const adminEnv = { ...env, ADMIN_SECRET } satisfies Env;

function adminRequest(path: string, init: RequestInit): Promise<Response> {
	return admin.request(`http://localhost${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${ADMIN_SECRET}`,
			"content-type": "application/json",
			...init.headers,
		},
	}, adminEnv);
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
});
