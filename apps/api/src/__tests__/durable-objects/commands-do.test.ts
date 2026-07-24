/**
 * CommandsDO integration tests
 *
 * Tests Agent-backed command persistence, default bootstrap, runtime CRUD,
 * shared value sources, and counter behavior.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { CommandsDO } from "../../durable-objects/commands-do";

async function createCommandsStub(name: string): Promise<DurableObjectStub<CommandsDO>> {
	const id = env.COMMANDS_DO.idFromName(name);
	const stub = env.COMMANDS_DO.get(id);
	await stub.setName(name);
	await stub.getAllCommands();
	return stub;
}

describe("CommandsDO", () => {
	it("bootstraps default commands on first start", async () => {
		const stub = await createCommandsStub(`commands-${crypto.randomUUID()}`);

		const keyboardResult = await stub.getCommand("keyboard");
		expect(keyboardResult.status).toBe("ok");
		if (keyboardResult.status === "ok") {
			expect(keyboardResult.value.responseType).toBe("static");
		}

		const todayResult = await stub.getCommandValue("today");
		expect(todayResult.status).toBe("ok");
		if (todayResult.status === "ok") {
			expect(todayResult.value).toBe("");
		}

		const projectResult = await stub.getCommand("project");
		expect(projectResult.status).toBe("ok");
		if (projectResult.status === "ok") {
			expect(projectResult.value.valueSourceName).toBe("today");
		}

		const dotfilesResult = await stub.getCommand("df");
		expect(dotfilesResult.status).toBe("ok");
		if (dotfilesResult.status === "ok") {
			expect(dotfilesResult.value.name).toBe("dotfiles");
			expect(dotfilesResult.value.aliases).toContain("df");
		}

		const planResult = await stub.getCommand("plan");
		expect(planResult.status).toBe("ok");
		if (planResult.status === "ok") {
			expect(planResult.value.responseType).toBe("static");
			expect(planResult.value.permission).toBe("everyone");
		}

		const planValueResult = await stub.getCommandValue("plan");
		expect(planValueResult.status).toBe("ok");
		if (planValueResult.status === "ok") {
			expect(planValueResult.value).toBe("Plannotator: https://plannotator.ai");
		}

		const herdrResult = await stub.getCommand("herdr");
		expect(herdrResult.status).toBe("ok");
		if (herdrResult.status === "ok") {
			expect(herdrResult.value.responseType).toBe("static");
			expect(herdrResult.value.permission).toBe("everyone");
		}

		const herdrValueResult = await stub.getCommandValue("herdr");
		expect(herdrValueResult.status).toBe("ok");
		if (herdrValueResult.status === "ok") {
			expect(herdrValueResult.value).toBe("Herdr: https://herdr.dev/");
		}

		const hexResult = await stub.getCommand("hex");
		expect(hexResult.status).toBe("ok");
		if (hexResult.status === "ok") {
			expect(hexResult.value.responseType).toBe("static");
			expect(hexResult.value.permission).toBe("everyone");
		}

		const hexValueResult = await stub.getCommandValue("hex");
		expect(hexValueResult.status).toBe("ok");
		if (hexValueResult.status === "ok") {
			expect(hexValueResult.value).toBe(
				"I am using Hex by Kit Langton: https://hex.kitlangton.com/",
			);
		}
	});

	it("creates, updates, and deletes runtime commands", async () => {
		const stub = await createCommandsStub(`commands-${crypto.randomUUID()}`);

		const createResult = await stub.createCommand({
			name: "runtime-note",
			description: "Runtime-created dynamic command",
			category: "info",
			responseType: "dynamic",
			permission: "everyone",
			writePermission: "moderator",
			initialValue: "hello runtime",
			outputTemplate: "Runtime says: {value}",
			emptyResponse: "No runtime note set.",
		});
		expect(createResult.status).toBe("ok");

		const initialValueResult = await stub.getCommandValue("runtime-note");
		expect(initialValueResult.status).toBe("ok");
		if (initialValueResult.status === "ok") {
			expect(initialValueResult.value).toBe("hello runtime");
		}

		const updateValueResult = await stub.setCommandValue("runtime-note", "updated runtime", "mod");
		expect(updateValueResult.status).toBe("ok");

		const updatedValueResult = await stub.getCommandValue("runtime-note");
		expect(updatedValueResult.status).toBe("ok");
		if (updatedValueResult.status === "ok") {
			expect(updatedValueResult.value).toBe("updated runtime");
		}

		const deleteResult = await stub.deleteCommand("runtime-note");
		expect(deleteResult.status).toBe("ok");

		const missingResult = await stub.getCommand("runtime-note");
		expect(missingResult.status).toBe("error");
	});

	it("deletes dependent commands when a shared value source is removed", async () => {
		const stub = await createCommandsStub(`commands-${crypto.randomUUID()}`);

		const todayResult = await stub.getCommand("today");
		expect(todayResult.status).toBe("ok");

		const projectResult = await stub.getCommand("project");
		expect(projectResult.status).toBe("ok");

		const deleteResult = await stub.deleteCommand("today");
		expect(deleteResult.status).toBe("ok");

		const missingTodayResult = await stub.getCommand("today");
		expect(missingTodayResult.status).toBe("error");

		const missingProjectResult = await stub.getCommand("project");
		expect(missingProjectResult.status).toBe("error");
	});

	it("supports computed commands with persisted counter state", async () => {
		const stub = await createCommandsStub(`commands-${crypto.randomUUID()}`);

		const createResult = await stub.createCommand({
			name: "custom-counter",
			description: "Custom computed counter command",
			category: "stats",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "custom-counter",
			counterSourceName: "custom-counter",
			initialCounter: 2,
		});
		expect(createResult.status).toBe("ok");

		const withValueResult = await stub.getCommandWithValue("custom-counter");
		expect(withValueResult.status).toBe("ok");
		if (withValueResult.status === "ok") {
			expect(withValueResult.value.value).toBeNull();
		}

		const incrementResult = await stub.incrementCommandCounter("custom-counter", 3);
		expect(incrementResult.status).toBe("ok");
		if (incrementResult.status === "ok") {
			expect(incrementResult.value).toBe(5);
		}

		const snapshotResult = await stub.getDebugSnapshot();
		expect(snapshotResult.status).toBe("ok");
		if (snapshotResult.status === "ok") {
			const command = snapshotResult.value.commands.find(
				(entry) => entry.name === "custom-counter",
			);
			expect(command?.counter).toBe(5);
			expect(snapshotResult.value.revision).toBeGreaterThan(0);
		}
	});
});
