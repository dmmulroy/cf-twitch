import { z } from "zod";

import {
	type ChatCommandDefinition,
	type CreateChatCommandInput,
	type UpdateChatCommandInput,
} from "../domain/chat-command-definition";

import type { CommandsError } from "../lib/errors";
import type { Result } from "better-result";

/** Runtime parser for the complete Chat Command registry debug projection. */
export const ChatCommandDebugSnapshotSchema = z.object({
	commands: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			category: z.enum(["info", "stats", "meta", "music"]),
			permission: z.enum(["everyone", "vip", "moderator", "broadcaster"]),
			enabled: z.boolean(),
			createdAt: z.iso.datetime({ offset: true }),
			aliases: z.array(z.string()),
			responseType: z.enum(["static", "dynamic", "computed"]),
			valueSourceName: z.string().nullable(),
			counterSourceName: z.string().nullable(),
			handlerKey: z.string().nullable(),
			outputTemplate: z.string().nullable(),
			emptyResponse: z.string().nullable(),
			writePermission: z.enum(["everyone", "vip", "moderator", "broadcaster"]).nullable(),
			value: z.string().nullable(),
			counter: z.number().int().nonnegative().nullable(),
		}),
	),
	totals: z.object({
		total: z.number().int().nonnegative(),
		enabled: z.number().int().nonnegative(),
		static: z.number().int().nonnegative(),
		dynamic: z.number().int().nonnegative(),
		computed: z.number().int().nonnegative(),
	}),
	revision: z.number().int().nonnegative(),
	initialized: z.boolean(),
});

/** Complete Chat Command registry debug projection. */
export type ChatCommandDebugSnapshot = z.infer<typeof ChatCommandDebugSnapshotSchema>;

/** Administers persisted Chat Command definitions and debug state. */
export interface ChatCommandAdministration {
	/** Lists every persisted Chat Command definition. */
	getAllCommands(): Promise<Result<readonly ChatCommandDefinition[], CommandsError>>;
	/** Creates one parsed Chat Command definition. */
	createCommand(
		input: CreateChatCommandInput,
	): Promise<Result<ChatCommandDefinition, CommandsError>>;
	/** Updates one Chat Command definition by canonical name. */
	updateCommand(
		name: string,
		patch: UpdateChatCommandInput,
	): Promise<Result<ChatCommandDefinition, CommandsError>>;
	/** Deletes one Chat Command definition by canonical name. */
	deleteCommand(name: string): Promise<Result<void, CommandsError>>;
	/** Reads the complete Chat Command registry debug projection. */
	getDebugSnapshot(): Promise<Result<ChatCommandDebugSnapshot, CommandsError>>;
}
