import { Result } from "better-result";

import { ChatCommandSendError } from "../../../lib/chat-command";
import { CommandNotFoundError, type CommandsError } from "../../../lib/errors";

import type { Command } from "../../../durable-objects/commands-do";
import type {
	ChatCommandMetric,
	ChatCommandMetrics,
	ChatSender,
	Clock,
	CommandCatalog,
	ComputedCommandHandlers,
	Logger,
} from "../../../lib/chat-command";
import type { Permission } from "../../../lib/permissions";

/**
 * Build command metadata for chat command tests.
 *
 * @param overrides - Required command name plus optional command field overrides.
 * @returns A complete Command test fixture.
 */
export function makeCommand(overrides: Partial<Command> & { name: string }): Command {
	return {
		name: overrides.name,
		description: overrides.description ?? `${overrides.name} command`,
		category: overrides.category ?? "info",
		responseType: overrides.responseType ?? "computed",
		permission: overrides.permission ?? "everyone",
		enabled: overrides.enabled ?? true,
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
		aliases: overrides.aliases ?? [],
		valueSourceName: overrides.valueSourceName ?? null,
		counterSourceName: overrides.counterSourceName ?? null,
		handlerKey: overrides.handlerKey ?? overrides.name,
		outputTemplate: overrides.outputTemplate ?? null,
		emptyResponse: overrides.emptyResponse ?? null,
		writePermission: overrides.writePermission ?? null,
	};
}

/**
 * In-memory command catalog fake for executor tests.
 *
 * @param name - Command name to read or mutate.
 * @param value - Stored command value to persist.
 * @param updatedBy - Display name of the updater.
 * @param permission - Permission used by the interface-compatible command list method.
 * @returns Result-wrapped fake catalog responses.
 */
export class FakeCommandCatalog implements CommandCatalog {
	commands = new Map<string, Command>();
	values = new Map<string, string | null>();

	async getCommand(name: string) {
		const command = this.commands.get(name);
		if (command === undefined) {
			return Result.err(new CommandNotFoundError({ commandName: name }));
		}
		return Result.ok(command);
	}

	async getCommandValue(name: string) {
		return Result.ok(this.values.get(name) ?? null);
	}

	async setCommandValue(name: string, value: string, updatedBy: string) {
		void updatedBy;
		this.values.set(name, value);
		return Result.ok();
	}

	async getCommandsByPermission(permission: Permission): Promise<Result<Command[], CommandsError>> {
		void permission;
		return Result.ok([...this.commands.values()]);
	}
}

/**
 * Chat sender fake that records sent messages and can simulate failures.
 *
 * @param message - Message text to record.
 * @returns A Result indicating whether the fake send succeeded.
 */
export class FakeChatSender implements ChatSender {
	sent: string[] = [];
	error: Error | null = null;

	async send(message: string) {
		if (this.error !== null) {
			return Result.err(new ChatCommandSendError({ cause: this.error }));
		}
		this.sent.push(message);
		return Result.ok();
	}
}

/**
 * Metric sink fake that records written chat command metrics.
 *
 * @param metric - Metric payload to record.
 * @returns Nothing.
 */
export class FakeMetrics implements ChatCommandMetrics {
	written: ChatCommandMetric[] = [];
	write(metric: ChatCommandMetric): void {
		this.written.push(metric);
	}
}

/**
 * Clock fake that always returns a fixed date.
 *
 * @param date - Date returned by now.
 * @returns The fixed date from now.
 */
export class FixedClock implements Clock {
	constructor(private readonly date: Date) {}
	now(): Date {
		return this.date;
	}
}

/**
 * Logger fake that discards all log events.
 *
 * @param message - Ignored log message.
 * @param context - Ignored log context.
 * @returns Nothing for log methods, or itself for child.
 */
export class NullLogger implements Logger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
	child(): Logger {
		return this;
	}
}

/**
 * Build an empty computed handler registry for tests.
 *
 * @returns An empty handler registry.
 */
export function noHandlers(): ComputedCommandHandlers {
	return {};
}
