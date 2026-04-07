/**
 * CommandsDO integration tests
 *
 * Tests Agent-backed command persistence, legacy hydration, runtime CRUD,
 * shared value sources, and counter behavior.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import { type CommandsAgentState, CommandsDO } from "../../durable-objects/commands-do";
import * as legacySchema from "../../durable-objects/schemas/commands-do.schema";

async function createCommandsStub(name: string): Promise<DurableObjectStub<CommandsDO>> {
	const id = env.COMMANDS_DO.idFromName(name);
	const stub = env.COMMANDS_DO.get(id);
	await stub.setName(name);
	await stub.getAllCommands();
	return stub;
}

function initialCommandsState(): CommandsAgentState {
	return {
		revision: 0,
		legacyImportCompleted: false,
		commandsByName: {},
		valuesByName: {},
		countersByName: {},
	};
}

describe("CommandsDO", () => {
	it("hydrates Agent state from legacy tables on startup", async () => {
		const stub = await createCommandsStub(`commands-${crypto.randomUUID()}`);
		const now = new Date().toISOString();

		await runInDurableObject(stub, async (instance: CommandsDO) => {
			const db = drizzle(instance.ctx.storage, { schema: legacySchema });
			await db.insert(legacySchema.commands).values({
				name: "custom-legacy",
				description: "Legacy imported command",
				category: "info",
				responseType: "dynamic",
				permission: "everyone",
				enabled: true,
				createdAt: now,
			});
			await db.insert(legacySchema.commandValues).values({
				commandName: "custom-legacy",
				value: "legacy value",
				updatedAt: now,
				updatedBy: "migration",
			});
			await db.insert(legacySchema.commandCounters).values({
				commandName: "custom-legacy",
				count: 7,
				updatedAt: now,
			});

			instance.setState(initialCommandsState());
			await instance.onStart();
		});

		const commandResult = await stub.getCommand("custom-legacy");
		expect(commandResult.status).toBe("ok");
		if (commandResult.status === "ok") {
			expect(commandResult.value.responseType).toBe("dynamic");
			expect(commandResult.value.writePermission).toBe("moderator");
		}

		const valueResult = await stub.getCommandValue("custom-legacy");
		expect(valueResult.status).toBe("ok");
		if (valueResult.status === "ok") {
			expect(valueResult.value).toBe("legacy value");
		}

		const counterResult = await stub.getCommandCounter("custom-legacy");
		expect(counterResult.status).toBe("ok");
		if (counterResult.status === "ok") {
			expect(counterResult.value).toBe(7);
		}
	});

	it("creates, updates, and deletes runtime commands without touching legacy migrations", async () => {
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
