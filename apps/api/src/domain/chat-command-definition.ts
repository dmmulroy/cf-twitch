import { z } from "zod";

/** Runtime parser for a canonical Chat Command name. */
export const ChatCommandNameSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z0-9-]+$/);
/** Runtime parser for Chat Command permission levels. */
export const ChatCommandPermissionSchema = z.enum(["everyone", "vip", "moderator", "broadcaster"]);
/** Runtime parser for Chat Command response strategies. */
export const ChatCommandResponseTypeSchema = z.enum(["static", "dynamic", "computed"]);
/** Runtime parser for Chat Command presentation categories. */
export const ChatCommandCategorySchema = z.enum(["info", "stats", "meta", "music"]);
/** Runtime parser for a stored Chat Command value. */
export const ChatCommandValueSchema = z.string().min(0).max(2000);
/** Runtime parser for a Chat Command handler key. */
export const ChatCommandHandlerKeySchema = z.string().min(1).max(100);
/** Runtime parser for a Chat Command output template. */
export const ChatCommandTemplateSchema = z.string().min(1).max(2000);
/** Runtime parser for timestamps persisted with Chat Command definitions. */
export const ChatCommandInstantSchema = z.iso.datetime({ offset: true });

const ChatCommandDefinitionBaseShape = {
	name: ChatCommandNameSchema,
	description: z.string().min(1).max(200),
	category: ChatCommandCategorySchema,
	permission: ChatCommandPermissionSchema,
	enabled: z.boolean(),
	createdAt: ChatCommandInstantSchema,
	aliases: z.array(ChatCommandNameSchema).max(20),
};

/** Runtime parser for a response-type-specific Chat Command definition. */
export const ChatCommandDefinitionSchema = z.discriminatedUnion("responseType", [
	z.strictObject({
		...ChatCommandDefinitionBaseShape,
		responseType: z.literal("static"),
		valueSourceName: ChatCommandNameSchema,
		counterSourceName: z.null(),
		handlerKey: z.null(),
		outputTemplate: ChatCommandTemplateSchema,
		emptyResponse: ChatCommandTemplateSchema,
		writePermission: z.null(),
	}),
	z.strictObject({
		...ChatCommandDefinitionBaseShape,
		responseType: z.literal("dynamic"),
		valueSourceName: ChatCommandNameSchema,
		counterSourceName: z.null(),
		handlerKey: z.null(),
		outputTemplate: ChatCommandTemplateSchema,
		emptyResponse: ChatCommandTemplateSchema,
		writePermission: ChatCommandPermissionSchema,
	}),
	z.strictObject({
		...ChatCommandDefinitionBaseShape,
		responseType: z.literal("computed"),
		valueSourceName: z.null(),
		counterSourceName: ChatCommandNameSchema.nullable(),
		handlerKey: ChatCommandHandlerKeySchema,
		outputTemplate: z.null(),
		emptyResponse: z.null(),
		writePermission: z.null(),
	}),
]);

/** Parsed persisted Chat Command definition. */
export type ChatCommandDefinition = z.infer<typeof ChatCommandDefinitionSchema>;

const CreateChatCommandBaseShape = {
	name: ChatCommandNameSchema,
	description: z.string().min(1).max(200),
	category: ChatCommandCategorySchema,
	permission: ChatCommandPermissionSchema,
	enabled: z.boolean().optional(),
	aliases: z.array(ChatCommandNameSchema).max(20).optional(),
	createdAt: ChatCommandInstantSchema.optional(),
};

/** Runtime parser for a response-type-specific Chat Command create input. */
export const CreateChatCommandInputSchema = z.discriminatedUnion("responseType", [
	z.strictObject({
		...CreateChatCommandBaseShape,
		responseType: z.literal("static"),
		valueSourceName: ChatCommandNameSchema.optional(),
		outputTemplate: ChatCommandTemplateSchema.optional(),
		emptyResponse: ChatCommandTemplateSchema.optional(),
		initialValue: ChatCommandValueSchema.optional(),
	}),
	z.strictObject({
		...CreateChatCommandBaseShape,
		responseType: z.literal("dynamic"),
		valueSourceName: ChatCommandNameSchema.optional(),
		outputTemplate: ChatCommandTemplateSchema.optional(),
		emptyResponse: ChatCommandTemplateSchema.optional(),
		writePermission: ChatCommandPermissionSchema.optional(),
		initialValue: ChatCommandValueSchema.optional(),
	}),
	z.strictObject({
		...CreateChatCommandBaseShape,
		responseType: z.literal("computed"),
		handlerKey: ChatCommandHandlerKeySchema,
		counterSourceName: ChatCommandNameSchema.optional(),
		initialCounter: z.number().int().nonnegative().optional(),
	}),
]);

/** Parsed input for creating one Chat Command definition. */
export type CreateChatCommandInput = z.infer<typeof CreateChatCommandInputSchema>;

/** Runtime parser for a non-empty Chat Command definition patch. */
export const UpdateChatCommandInputSchema = z
	.strictObject({
		description: z.string().min(1).max(200).optional(),
		category: ChatCommandCategorySchema.optional(),
		responseType: ChatCommandResponseTypeSchema.optional(),
		permission: ChatCommandPermissionSchema.optional(),
		enabled: z.boolean().optional(),
		aliases: z.array(ChatCommandNameSchema).max(20).optional(),
		valueSourceName: ChatCommandNameSchema.nullable().optional(),
		counterSourceName: ChatCommandNameSchema.nullable().optional(),
		handlerKey: ChatCommandHandlerKeySchema.nullable().optional(),
		outputTemplate: ChatCommandTemplateSchema.nullable().optional(),
		emptyResponse: ChatCommandTemplateSchema.nullable().optional(),
		writePermission: ChatCommandPermissionSchema.nullable().optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Command patch must not be empty",
	});

/** Parsed non-empty Chat Command definition patch. */
export type UpdateChatCommandInput = z.infer<typeof UpdateChatCommandInputSchema>;
