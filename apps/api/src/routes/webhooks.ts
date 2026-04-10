/**
 * Twitch EventSub Webhook Handler
 *
 * Receives and verifies EventSub webhook events from Twitch.
 * Handles challenge verification, signature validation, and event routing.
 */

import { Result } from "better-result";
import { Hono } from "hono";
import { z } from "zod";

import { UserStatsNotFoundError } from "../durable-objects/keyboard-raffle-do";
import { type ChatCommandStatus, writeChatCommandMetric } from "../lib/analytics";
import { parseCommandWithArg } from "../lib/commands";
import { getStub } from "../lib/durable-objects";
import { CommandNotUpdateableError } from "../lib/errors";
import { logger, normalizeError, startTimer, withLogContext } from "../lib/logger";
import { type Permission, getUserPermission, hasPermission } from "../lib/permissions";
import { type AppRouteEnv, getRequestLogger } from "../lib/request-context";
import { TwitchService } from "../services/twitch-service";

import type { UnlockedAchievement } from "../durable-objects/achievements-do";
import type { Command } from "../durable-objects/commands-do";
import type { LeaderboardEntry } from "../durable-objects/schemas/keyboard-raffle-do.schema";
import type { QueuedTrack } from "../durable-objects/song-queue-do";
import type { Env } from "../index";

// =============================================================================
// Chat Command Handlers (migrated from ChatCommandWorkflow)
// =============================================================================

const RANDOM_EMOTES = ["PogChamp", "Kappa", "LUL", "SeemsGood", "HeyGuys"];

const webhooks = new Hono<AppRouteEnv<Env>>();

interface ParsedChatCommand {
	command: string;
	arg: string | null;
}

interface ComputedCommandContext {
	arg: string | null;
	userPermission: Permission;
	userName: string;
	userId: string;
}

function parseCommand(text: string): ParsedChatCommand | null {
	return parseCommandWithArg(text);
}

async function handleSongCommand(): Promise<string> {
	logger.info("Chat song command started", {
		event: "chat_command.song.started",
		component: "route",
		command: "song",
	});
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getCurrentlyPlaying();

	if (result.status === "error") {
		logger.error("Chat song command failed", {
			event: "chat_command.song.failed",
			component: "route",
			command: "song",
			...result.error,
		});
		return "Sorry, couldn't get the current song info.";
	}

	const { track } = result.value;
	if (!track) {
		logger.info("Chat song command succeeded", {
			event: "chat_command.song.succeeded",
			component: "route",
			command: "song",
			track_id: undefined,
		});
		return "No track currently playing.";
	}

	const artistStr = track.artists.join(", ");
	const attribution =
		track.requesterUserId === "unknown" ? "" : ` - requested by @${track.requesterDisplayName}`;
	logger.info("Chat song command succeeded", {
		event: "chat_command.song.succeeded",
		component: "route",
		command: "song",
		track_id: track.id,
	});
	return `Now playing: "${track.name}" by ${artistStr}${attribution}`;
}

async function handleQueueCommand(): Promise<string> {
	logger.info("Chat queue command started", {
		event: "chat_command.queue.started",
		component: "route",
		command: "queue",
	});
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getSongQueue(4);

	if (result.status === "error") {
		logger.error("Chat queue command failed", {
			event: "chat_command.queue.failed",
			component: "route",
			command: "queue",
			...result.error,
		});
		return "Sorry, couldn't get the queue info.";
	}

	const { tracks } = result.value;
	logger.info("Chat queue command succeeded", {
		event: "chat_command.queue.succeeded",
		component: "route",
		command: "queue",
		returned_count: tracks.length,
	});
	if (tracks.length === 0) {
		return "Queue is empty.";
	}

	const trackLines = tracks.map((track: QueuedTrack, idx: number) => {
		const requester =
			track.requesterUserId === "unknown" ? "" : ` (@${track.requesterDisplayName})`;
		return `${idx + 1}. "${track.name}" by ${track.artists.join(", ")}${requester}`;
	});

	return `Next up: ${trackLines.join(" | ")}`;
}

function renderStoredValueTemplate(value: string, userName: string): string {
	const emote = RANDOM_EMOTES[Math.floor(Math.random() * RANDOM_EMOTES.length)] ?? "PogChamp";

	return value.replaceAll("${user}", userName).replaceAll("${random.emote}", emote);
}

function applyOutputTemplate(template: string | null, renderedValue: string): string {
	if (template === null) {
		return renderedValue;
	}

	return template.replaceAll("{value}", renderedValue);
}

async function handleStoredCommand(command: Command, userName: string): Promise<string> {
	logger.info("Stored chat command started", {
		event: "chat_command.stored.started",
		component: "route",
		command: command.name,
	});
	const stub = getStub("COMMANDS_DO");
	const result = await stub.getCommandValue(command.name);

	if (result.status === "error") {
		logger.error("Stored chat command failed", {
			event: "chat_command.stored.failed",
			component: "route",
			command: command.name,
			...result.error,
		});
		return `Sorry, couldn't retrieve !${command.name}.`;
	}

	const value = result.value;
	logger.info("Stored chat command succeeded", {
		event: "chat_command.stored.succeeded",
		component: "route",
		command: command.name,
		message_length: value?.length ?? 0,
	});
	if (value === null || value.length === 0) {
		return command.emptyResponse ?? `${command.name} info is not available.`;
	}

	return applyOutputTemplate(command.outputTemplate, renderStoredValueTemplate(value, userName));
}

async function handleTimeCommand(): Promise<string> {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
		timeZoneName: "short",
	});
	logger.info("Time chat command succeeded", {
		event: "chat_command.time.succeeded",
		component: "route",
		command: "time",
	});
	return `Current time is: ${formatter.format(new Date())}`;
}

async function handleSkillIssueCommand(): Promise<string> {
	const stub = getStub("COMMANDS_DO");
	const result = await stub.incrementCommandCounter("skillissue");

	if (result.status === "error") {
		logger.error("Failed to increment skillissue counter", {
			component: "route",
			command: "skillissue",
			...result.error,
		});
		return "Couldn't count that skill issue right now.";
	}
	logger.info("Skillissue command incremented", {
		event: "chat_command.skillissue.incremented",
		component: "route",
		command: "skillissue",
		count: result.value,
	});
	return `@dillon has ${result.value} SkillIssue so far`;
}

function getInsufficientWritePermissionMessage(
	requiredPermission: Permission,
	commandName: string,
): string {
	switch (requiredPermission) {
		case "everyone":
			return `!${commandName} can be updated by anyone.`;
		case "vip":
			return `Only VIPs and moderators can update !${commandName}.`;
		case "moderator":
			return `Only moderators can update !${commandName}.`;
		case "broadcaster":
			return `Only the broadcaster can update !${commandName}.`;
	}
}

async function handleUpdateCommand(
	arg: string | null,
	userPermission: Permission,
	userName: string,
): Promise<string> {
	if (!arg) {
		logger.warn("Update chat command validation failed", {
			event: "chat_command.update.validation_failed",
			component: "route",
			command: "update",
		});
		return "Usage: !update <command> <value>";
	}

	const parts = arg.split(/\s+/);
	const targetCommandRaw = parts[0];
	if (!targetCommandRaw) {
		logger.warn("Update chat command validation failed", {
			event: "chat_command.update.validation_failed",
			component: "route",
			command: "update",
		});
		return "Usage: !update <command> <value>";
	}

	const targetCommand = targetCommandRaw.toLowerCase();
	const newValue = arg.slice(targetCommandRaw.length).trim();
	if (newValue.length === 0) {
		logger.warn("Update chat command validation failed", {
			event: "chat_command.update.validation_failed",
			component: "route",
			command: "update",
			target_user: targetCommand,
		});
		return `Usage: !update ${targetCommand} <value>`;
	}

	const stub = getStub("COMMANDS_DO");
	const commandResult = await stub.getCommand(targetCommand);
	if (commandResult.status === "error") {
		logger.error("Failed to look up command for update", {
			event: "webhook.twitch.chat_message.command_lookup_failed",
			component: "route",
			command: targetCommand,
			...commandResult.error,
		});
		return "Sorry, couldn't update the command.";
	}

	const command = commandResult.value;
	if (command.writePermission === null) {
		logger.warn("Update chat command permission denied", {
			event: "chat_command.update.permission_denied",
			component: "route",
			command: targetCommand,
			required_permission: null,
			caller_permission: userPermission,
		});
		return `!${targetCommand} is not updateable.`;
	}

	if (!hasPermission(userPermission, command.writePermission)) {
		logger.warn("Update chat command permission denied", {
			event: "chat_command.update.permission_denied",
			component: "route",
			command: targetCommand,
			required_permission: command.writePermission,
			caller_permission: userPermission,
		});
		return getInsufficientWritePermissionMessage(command.writePermission, targetCommand);
	}

	const result = await stub.setCommandValue(targetCommand, newValue, userName);
	if (result.status === "error") {
		if (CommandNotUpdateableError.is(result.error)) {
			logger.warn("Update chat command validation failed", {
				event: "chat_command.update.validation_failed",
				component: "route",
				command: targetCommand,
			});
			return `!${targetCommand} is not updateable.`;
		}
		logger.error("Failed to update command", {
			component: "route",
			command: targetCommand,
			...result.error,
		});
		return "Sorry, couldn't update the command.";
	}

	logger.info("Update chat command succeeded", {
		event: "chat_command.update.succeeded",
		component: "route",
		command: targetCommand,
		updated_by: userName,
	});
	return `Updated !${targetCommand}`;
}

async function handleAchievementsCommand(
	arg: string | null,
	callerDisplayName: string,
): Promise<string> {
	const targetUser = arg ?? callerDisplayName;
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUnlockedAchievements(targetUser);

	if (result.status === "error") {
		logger.error("Achievements chat command failed", {
			event: "chat_command.achievements.failed",
			component: "route",
			command: "achievements",
			target_user: targetUser,
			...result.error,
		});
		return `Sorry, couldn't retrieve achievements for @${targetUser}.`;
	}

	const achievements: UnlockedAchievement[] = result.value;
	logger.info("Achievements chat command succeeded", {
		event: "chat_command.achievements.succeeded",
		component: "route",
		command: "achievements",
		target_user: targetUser,
		unlocked_count: achievements.length,
	});
	if (achievements.length === 0) {
		return `@${targetUser} hasn't unlocked any achievements yet.`;
	}

	const names = achievements.map((achievement) => achievement.name).join(", ");
	return `@${targetUser} has unlocked ${achievements.length} achievement${achievements.length === 1 ? "" : "s"}: ${names}`;
}

async function handleStatsCommand(
	arg: string | null,
	callerUserId: string,
	callerDisplayName: string,
): Promise<string> {
	const isSelf = arg === null;
	const targetUser = arg ?? callerDisplayName;

	const achievementsStub = getStub("ACHIEVEMENTS_DO");
	const [unlockedResult, definitionsResult] = await Promise.all([
		achievementsStub.getUnlockedAchievements(targetUser),
		achievementsStub.getDefinitions(),
	]);

	let achievementStats = "?/?";
	let unlockedCount: number | null = null;
	let totalAchievementCount: number | null = null;
	if (unlockedResult.status === "ok" && definitionsResult.status === "ok") {
		unlockedCount = unlockedResult.value.length;
		totalAchievementCount = definitionsResult.value.length;
		achievementStats = `${unlockedCount}/${totalAchievementCount}`;
	} else {
		logger.warn("Stats chat command partial failure", {
			event: "chat_command.stats.partial_failure",
			component: "route",
			command: "stats",
			target_user: targetUser,
			reason: "achievement_stats_unavailable",
		});
	}

	const raffleStub = getStub("KEYBOARD_RAFFLE_DO");
	const songQueueStub = getStub("SONG_QUEUE_DO");

	const formatRaffleStats = (entry: {
		totalRolls: number;
		totalWins: number;
		closestDistance: number | null;
	}) => {
		const base = `${entry.totalRolls} rolls`;
		const extras: string[] = [];
		if (entry.closestDistance !== null) {
			extras.push(`closest: ${entry.closestDistance}`);
		}
		if (entry.totalWins > 0) {
			extras.push(`${entry.totalWins} win${entry.totalWins > 1 ? "s" : ""}!`);
		}
		return extras.length > 0 ? `${base} (${extras.join(", ")})` : base;
	};

	const [songResult, raffleResult] = await Promise.all([
		isSelf
			? songQueueStub.getUserRequestCount(callerUserId)
			: songQueueStub.getUserRequestCountByDisplayName(targetUser),
		isSelf
			? raffleStub.getUserStats(callerUserId)
			: raffleStub.getUserStatsByDisplayName(targetUser),
	]);

	let songCount = 0;
	if (songResult.status === "ok") {
		songCount = songResult.value;
	} else {
		logger.warn("Stats chat command partial failure", {
			event: "chat_command.stats.partial_failure",
			component: "route",
			command: "stats",
			target_user: targetUser,
			reason: "song_count_unavailable",
			...songResult.error,
		});
	}

	let raffleStats = "0 rolls";
	if (raffleResult.status === "ok") {
		raffleStats = formatRaffleStats(raffleResult.value);
	} else if (!UserStatsNotFoundError.is(raffleResult.error)) {
		logger.warn("Stats chat command partial failure", {
			event: "chat_command.stats.partial_failure",
			component: "route",
			command: "stats",
			target_user: targetUser,
			reason: "raffle_stats_unavailable",
			...raffleResult.error,
		});
	}

	const noStatsForTargetUser =
		!isSelf &&
		songResult.status === "ok" &&
		songResult.value === 0 &&
		unlockedCount === 0 &&
		totalAchievementCount !== null &&
		raffleResult.status === "error" &&
		UserStatsNotFoundError.is(raffleResult.error);

	if (noStatsForTargetUser) {
		logger.info("Stats chat command succeeded", {
			event: "chat_command.stats.succeeded",
			component: "route",
			command: "stats",
			target_user: targetUser,
			song_count: songCount,
			unlocked_count: unlockedCount ?? 0,
		});
		return `No records found for @${targetUser} yet — no songs, achievements, or raffle stats.`;
	}

	logger.info("Stats chat command succeeded", {
		event: "chat_command.stats.succeeded",
		component: "route",
		command: "stats",
		target_user: targetUser,
		song_count: songCount,
		unlocked_count: unlockedCount ?? 0,
	});
	return `@${targetUser} — Songs: ${songCount} | Achievements: ${achievementStats} | Raffles: ${raffleStats}`;
}

async function handleRaffleLeaderboardCommand(): Promise<string> {
	const stub = getStub("KEYBOARD_RAFFLE_DO");
	const result = await stub.getLeaderboard({ sortBy: "wins", limit: 5 });

	if (result.status === "error") {
		logger.error("Raffle leaderboard chat command failed", {
			event: "chat_command.raffle_leaderboard.failed",
			component: "route",
			command: "raffle-leaderboard",
			...result.error,
		});
		return "Sorry, couldn't retrieve the raffle leaderboard.";
	}

	const entries: LeaderboardEntry[] = result.value;
	logger.info("Raffle leaderboard chat command succeeded", {
		event: "chat_command.raffle_leaderboard.succeeded",
		component: "route",
		command: "raffle-leaderboard",
		returned_count: entries.length,
	});
	if (entries.length === 0) {
		return "No raffle rolls recorded yet.";
	}

	const winners = entries.filter((entry) => entry.totalWins > 0);
	if (winners.length === 0) {
		return "No raffle winners yet — be the first!";
	}

	const leaderboard = winners
		.map((entry, idx) => `${idx + 1}. @${entry.displayName} (${entry.totalWins})`)
		.join(" ");

	return `Raffle wins: ${leaderboard}`;
}

async function handleCommandsCommand(userPermission: Permission): Promise<string> {
	const stub = getStub("COMMANDS_DO");
	const result = await stub.getCommandsByPermission(userPermission);

	if (result.status === "error") {
		logger.error("Commands chat command failed", {
			event: "chat_command.commands.failed",
			component: "route",
			command: "commands",
			caller_permission: userPermission,
			...result.error,
		});
		return "Sorry, couldn't retrieve the commands list.";
	}

	const commands: Command[] = result.value;
	if (commands.length === 0) {
		return "No commands available.";
	}

	const commandsByPermission: Record<Permission, Command[]> = {
		everyone: [],
		vip: [],
		moderator: [],
		broadcaster: [],
	};
	for (const command of commands) {
		commandsByPermission[command.permission].push(command);
	}

	const sections: string[] = [];
	sections.push(
		`Commands: ${commandsByPermission.everyone.map((command) => `!${command.name}`).join(" ")}`,
	);

	if (commandsByPermission.vip.length > 0 && hasPermission(userPermission, "vip")) {
		sections.push(
			`VIP: ${commandsByPermission.vip.map((command) => `!${command.name}`).join(" ")}`,
		);
	}

	if (commandsByPermission.moderator.length > 0 && hasPermission(userPermission, "moderator")) {
		sections.push(
			`Mod: ${commandsByPermission.moderator.map((command) => `!${command.name}`).join(" ")}`,
		);
	}

	if (commandsByPermission.broadcaster.length > 0 && hasPermission(userPermission, "broadcaster")) {
		sections.push(
			`Broadcaster: ${commandsByPermission.broadcaster.map((command) => `!${command.name}`).join(" ")}`,
		);
	}

	logger.info("Commands chat command succeeded", {
		event: "chat_command.commands.succeeded",
		component: "route",
		command: "commands",
		caller_permission: userPermission,
		returned_count: commands.length,
	});
	return sections.join(" | ");
}

const computedCommandHandlers: Record<
	string,
	(context: ComputedCommandContext) => Promise<string>
> = {
	achievements: async ({ arg, userName }) => handleAchievementsCommand(arg, userName),
	commands: async ({ userPermission }) => handleCommandsCommand(userPermission),
	queue: async () => handleQueueCommand(),
	"raffle-leaderboard": async () => handleRaffleLeaderboardCommand(),
	skillissue: async () => handleSkillIssueCommand(),
	song: async () => handleSongCommand(),
	stats: async ({ arg, userId, userName }) => handleStatsCommand(arg, userId, userName),
	time: async () => handleTimeCommand(),
	update: async ({ arg, userPermission, userName }) =>
		handleUpdateCommand(arg, userPermission, userName),
};

async function handleChatCommand(
	chatMessage: z.infer<typeof ChatMessageEventSchema>,
	env: Env,
	parsed: ParsedChatCommand,
	command: Command,
): Promise<void> {
	const timer = startTimer();
	let status: ChatCommandStatus = "success";
	let error: string | undefined;
	const userPermission = getUserPermission(chatMessage.badges);
	const chatLogger = logger.child({
		component: "route",
		message_id: chatMessage.message_id,
		user_id: chatMessage.chatter_user_id,
		user_display_name: chatMessage.chatter_user_name,
		command: parsed.command,
		handler_key: command.handlerKey,
		response_type: command.responseType,
	});

	chatLogger.info("Processing chat command", {
		event: "chat_command.processing.started",
	});

	let responseMessage: string;
	if (command.responseType === "computed") {
		const handlerKey = command.handlerKey;
		const handler = handlerKey ? computedCommandHandlers[handlerKey] : undefined;
		if (!handler) {
			chatLogger.warn("No computed command handler registered", {
				event: "webhook.twitch.chat_message.command_failed",
				reason: "missing_handler",
			});
			responseMessage = `!${parsed.command} is configured but has no live handler.`;
		} else {
			responseMessage = await handler({
				arg: parsed.arg,
				userPermission,
				userName: chatMessage.chatter_user_name,
				userId: chatMessage.chatter_user_id,
			});
		}
	} else {
		responseMessage = await handleStoredCommand(command, chatMessage.chatter_user_name);
	}

	const twitchService = new TwitchService(env);
	const sendResult = await twitchService.sendChatMessage(responseMessage);

	if (sendResult.status === "error") {
		status = "error";
		error = sendResult.error.message;
		chatLogger.warn("Failed to send chat response", {
			event: "chat_command.response.send_failed",
			message_length: responseMessage.length,
			...sendResult.error,
		});
	} else {
		chatLogger.info("Chat response sent", {
			event: "chat_command.response.send_succeeded",
			message_length: responseMessage.length,
		});
	}

	chatLogger.info("Completed chat command processing", {
		event: "chat_command.processing.completed",
		status,
		duration_ms: timer(),
		error_message: error,
	});

	writeChatCommandMetric(env.ANALYTICS, {
		command: parsed.command,
		userId: chatMessage.chatter_user_id,
		userName: chatMessage.chatter_user_name,
		status,
		durationMs: timer(),
		error,
	});
}

// Zod schemas for EventSub webhook payloads
const EventSubHeadersSchema = z.object({
	"twitch-eventsub-message-id": z.string(),
	"twitch-eventsub-message-retry": z.string(),
	"twitch-eventsub-message-type": z.string(),
	"twitch-eventsub-message-signature": z.string(),
	"twitch-eventsub-message-timestamp": z.string(),
	"twitch-eventsub-subscription-type": z.string(),
	"twitch-eventsub-subscription-version": z.string(),
});

const EventSubChallengeSchema = z.object({
	subscription: z.object({
		id: z.string(),
		type: z.string(),
		version: z.string(),
		status: z.string(),
		cost: z.number(),
		condition: z.record(z.string(), z.unknown()),
		transport: z.object({
			method: z.string(),
			callback: z.string(),
		}),
		created_at: z.string(),
	}),
	challenge: z.string(),
});

// Redemption event schema for channel point rewards
const RedemptionEventSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	user_login: z.string(),
	user_name: z.string(),
	broadcaster_user_id: z.string(),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	reward: z.object({
		id: z.string(),
		title: z.string(),
		cost: z.number(),
		prompt: z.string(),
	}),
	user_input: z.string(),
	status: z.string(),
	redeemed_at: z.string(),
});

// Chat badge schema (Twitch EventSub format)
const ChatBadgeSchema = z.object({
	set_id: z.string(),
	id: z.string(),
	info: z.string(),
});

// Chat message event schema
const ChatMessageEventSchema = z.object({
	broadcaster_user_id: z.string(),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	chatter_user_id: z.string(),
	chatter_user_login: z.string(),
	chatter_user_name: z.string(),
	message_id: z.string(),
	message: z.object({
		text: z.string(),
		fragments: z.array(z.unknown()),
	}),
	badges: z.array(ChatBadgeSchema),
});

const EventSubNotificationSchema = z.object({
	subscription: z.object({
		id: z.string(),
		type: z.string(),
		version: z.string(),
		status: z.string(),
		cost: z.number(),
		condition: z.record(z.string(), z.unknown()),
		transport: z.object({
			method: z.string(),
			callback: z.string().optional(),
		}),
		created_at: z.string(),
	}),
	event: z.record(z.string(), z.unknown()),
});

/**
 * Verify the HMAC-SHA256 signature of the webhook request
 */
async function verifySignature(
	secret: string,
	messageId: string,
	timestamp: string,
	body: string,
	signature: string,
): Promise<boolean> {
	// Construct the message to verify
	const message = messageId + timestamp + body;

	// Import the secret key
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	// Sign the message
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

	// Convert to hex string
	const hexSignature = Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Compare signatures (signature from header is in format "sha256=...")
	const expectedSignature = `sha256=${hexSignature}`;

	return expectedSignature === signature;
}

/**
 * Check if the timestamp is within 10 minutes
 */
function isTimestampValid(timestamp: string): boolean {
	const messageTime = new Date(timestamp).getTime();
	const now = Date.now();
	const tenMinutes = 10 * 60 * 1000;

	return Math.abs(now - messageTime) < tenMinutes;
}

/**
 * POST /webhooks/twitch
 *
 * Receives EventSub webhook events from Twitch.
 * Handles:
 * - Challenge verification (webhook_callback_verification)
 * - Event notifications (notification)
 * - Revocation notifications (revocation)
 */
// AI: create hono middleware for handling the header validation
webhooks.post("/twitch", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/webhooks/twitch", component: "route" });
	const headers = c.req.header();
	const headersParsed = EventSubHeadersSchema.safeParse(headers);
	if (!headersParsed.success) {
		routeLogger.error("Invalid EventSub headers", {
			event: "webhook.twitch.headers_invalid",
			error: headersParsed.error,
		});
		return c.json({ error: "Invalid headers" }, 400);
	}

	const {
		"twitch-eventsub-message-id": messageId,
		"twitch-eventsub-message-retry": retryCount,
		"twitch-eventsub-message-type": messageType,
		"twitch-eventsub-message-signature": signature,
		"twitch-eventsub-message-timestamp": timestamp,
		"twitch-eventsub-subscription-type": subscriptionType,
	} = headersParsed.data;

	return withLogContext(
		{
			trace_id: messageId,
			message_id: messageId,
			subscription_type: subscriptionType,
		},
		async () => {
			const webhookLogger = routeLogger.child({
				trace_id: messageId,
				message_id: messageId,
				subscription_type: subscriptionType,
			});
			const rawBody = await c.req.text();
			webhookLogger.info("Twitch webhook received", {
				event: "webhook.twitch.received",
				message_id: messageId,
				message_type: messageType,
				subscription_type: subscriptionType,
				retry_count: Number(retryCount),
				timestamp,
				body_size_bytes: rawBody.length,
			});

			if (!isTimestampValid(timestamp)) {
				webhookLogger.warn("EventSub message timestamp too old", {
					event: "webhook.twitch.timestamp_invalid",
					message_id: messageId,
					timestamp,
				});
				return c.json({ error: "Message too old" }, 403);
			}

			const isValid = await verifySignature(
				c.env.TWITCH_EVENTSUB_SECRET,
				messageId,
				timestamp,
				rawBody,
				signature,
			);

			if (!isValid) {
				webhookLogger.warn("EventSub signature verification failed", {
					event: "webhook.twitch.signature_invalid",
					message_id: messageId,
					subscription_type: subscriptionType,
				});
				return c.json({ error: "Invalid signature" }, 403);
			}

			const bodyResult = Result.try({
				try: () => JSON.parse(rawBody) as unknown,
				catch: (e) => new Error(`Invalid JSON: ${String(e)}`),
			});

			if (bodyResult.status === "error") {
				webhookLogger.error("Failed to parse webhook body", {
					event: "webhook.twitch.body_parse_failed",
					message_id: messageId,
					body_size_bytes: rawBody.length,
					...normalizeError(bodyResult.error),
				});
				return c.json({ error: "Invalid JSON body" }, 400);
			}

			const body = bodyResult.value;

			if (messageType === "webhook_callback_verification") {
				const parsed = EventSubChallengeSchema.safeParse(body);
				if (!parsed.success) {
					webhookLogger.error("Invalid challenge payload", {
						event: "webhook.twitch.body_parse_failed",
						message_id: messageId,
						error: parsed.error,
					});
					return c.json({ error: "Invalid payload" }, 400);
				}

				webhookLogger.info("EventSub challenge received", {
					event: "webhook.twitch.challenge.received",
					subscription_id: parsed.data.subscription.id,
					subscription_type: parsed.data.subscription.type,
				});
				webhookLogger.info("Responding to EventSub challenge", {
					event: "webhook.twitch.challenge.responded",
					subscription_id: parsed.data.subscription.id,
					subscription_type: parsed.data.subscription.type,
				});
				return c.text(parsed.data.challenge, 200);
			}

			if (messageType === "revocation") {
				webhookLogger.warn("EventSub subscription revoked", {
					event: "webhook.twitch.revocation.received",
					message_id: messageId,
					subscription_type: subscriptionType,
				});
				return c.json({ success: true }, 200);
			}

			if (messageType === "notification") {
				const parsed = EventSubNotificationSchema.safeParse(body);
				if (!parsed.success) {
					webhookLogger.error("Invalid notification payload", {
						event: "webhook.twitch.body_parse_failed",
						message_id: messageId,
						error: parsed.error,
					});
					return c.json({ error: "Invalid payload" }, 400);
				}

				const { subscription, event } = parsed.data;
				webhookLogger.info("EventSub notification received", {
					event: "webhook.twitch.notification.received",
					message_id: messageId,
					subscription_id: subscription.id,
					subscription_type: subscription.type,
					event_timestamp:
						typeof event["redeemed_at"] === "string"
							? event["redeemed_at"]
							: typeof event["started_at"] === "string"
								? event["started_at"]
								: timestamp,
				});

				try {
					switch (subscription.type) {
						case "stream.online": {
							webhookLogger.info("Routing stream online event", {
								event: "webhook.twitch.stream_online.routed",
								message_id: messageId,
								event_timestamp: timestamp,
							});
							const stub = getStub("STREAM_LIFECYCLE_DO");
							const result = await stub.onStreamOnline(timestamp);
							if (result.status === "error") {
								webhookLogger.error("Stream online event failed", {
									event: "webhook.twitch.stream_online.failed",
									message_id: messageId,
									event_timestamp: timestamp,
									...result.error,
								});
							} else {
								webhookLogger.info("Stream online event processed", {
									event: "webhook.twitch.stream_online.processed",
									message_id: messageId,
									event_timestamp: timestamp,
								});
							}
							break;
						}

						case "stream.offline": {
							webhookLogger.info("Routing stream offline event", {
								event: "webhook.twitch.stream_offline.routed",
								message_id: messageId,
								event_timestamp: timestamp,
							});
							const stub = getStub("STREAM_LIFECYCLE_DO");
							const result = await stub.onStreamOffline(timestamp);
							if (result.status === "error") {
								webhookLogger.error("Stream offline event failed", {
									event: "webhook.twitch.stream_offline.failed",
									message_id: messageId,
									event_timestamp: timestamp,
									...result.error,
								});
							} else {
								webhookLogger.info("Stream offline event processed", {
									event: "webhook.twitch.stream_offline.processed",
									message_id: messageId,
									event_timestamp: timestamp,
								});
							}
							break;
						}

						case "channel.channel_points_custom_reward_redemption.add": {
							const redemptionResult = RedemptionEventSchema.safeParse(event);
							if (!redemptionResult.success) {
								webhookLogger.error("Invalid redemption event payload", {
									event: "webhook.twitch.redemption.payload_invalid",
									message_id: messageId,
									error: redemptionResult.error,
								});
								break;
							}
							const redemption = redemptionResult.data;
							const rewardId = redemption.reward.id;
							webhookLogger.info("Redemption received", {
								event: "webhook.twitch.redemption.received",
								redemption_id: redemption.id,
								reward_id: rewardId,
								reward_title: redemption.reward.title,
								user_id: redemption.user_id,
								user_display_name: redemption.user_name,
								input_length: redemption.user_input.length,
							});

							if (c.env.SONG_REQUEST_REWARD_ID && rewardId === c.env.SONG_REQUEST_REWARD_ID) {
								webhookLogger.info("Song request route selected", {
									event: "webhook.twitch.redemption.route_selected",
									redemption_id: redemption.id,
									reward_id: rewardId,
									saga_id: redemption.id,
									outcome: "song_request",
								});
								const stub = getStub("SONG_REQUEST_SAGA_DO", redemption.id);
								const result = await stub.start(redemption);
								if (result.status === "error") {
									webhookLogger.error("Song request saga failed to start", {
										event: "webhook.twitch.redemption.song_request_saga_failed",
										redemption_id: redemption.id,
										reward_id: rewardId,
										saga_id: redemption.id,
										...result.error,
									});
								} else {
									webhookLogger.info("Song request saga started", {
										event: "webhook.twitch.redemption.song_request_saga_started",
										redemption_id: redemption.id,
										reward_id: rewardId,
										saga_id: redemption.id,
										user_id: redemption.user_id,
										user_display_name: redemption.user_name,
									});
								}
							} else if (
								c.env.KEYBOARD_RAFFLE_REWARD_ID &&
								rewardId === c.env.KEYBOARD_RAFFLE_REWARD_ID
							) {
								webhookLogger.info("Keyboard raffle route selected", {
									event: "webhook.twitch.redemption.route_selected",
									redemption_id: redemption.id,
									reward_id: rewardId,
									saga_id: redemption.id,
									outcome: "keyboard_raffle",
								});
								const stub = getStub("KEYBOARD_RAFFLE_SAGA_DO", redemption.id);
								const result = await stub.start(redemption);
								if (result.status === "error") {
									webhookLogger.error("Keyboard raffle saga failed to start", {
										event: "webhook.twitch.redemption.keyboard_raffle_saga_failed",
										redemption_id: redemption.id,
										reward_id: rewardId,
										saga_id: redemption.id,
										...result.error,
									});
								} else {
									webhookLogger.info("Keyboard raffle saga started", {
										event: "webhook.twitch.redemption.keyboard_raffle_saga_started",
										redemption_id: redemption.id,
										reward_id: rewardId,
										saga_id: redemption.id,
										user_id: redemption.user_id,
										user_display_name: redemption.user_name,
									});
								}
							} else {
								webhookLogger.warn("Unknown reward ID, skipping redemption", {
									event: "webhook.twitch.redemption.unknown_reward",
									redemption_id: redemption.id,
									reward_id: rewardId,
									reward_title: redemption.reward.title,
									user_id: redemption.user_id,
									user_display_name: redemption.user_name,
								});
							}
							break;
						}

						case "channel.chat.message": {
							const chatResult = ChatMessageEventSchema.safeParse(event);
							if (!chatResult.success) {
								webhookLogger.error("Invalid chat message event payload", {
									event: "webhook.twitch.chat_message.payload_invalid",
									message_id: messageId,
									error: chatResult.error,
								});
								break;
							}
							const chatMessage = chatResult.data;
							const userPermission = getUserPermission(chatMessage.badges);
							const messageText = chatMessage.message.text.trim().toLowerCase();
							webhookLogger.info("Chat message received", {
								event: "webhook.twitch.chat_message.received",
								message_id: chatMessage.message_id,
								chatter_user_id: chatMessage.chatter_user_id,
								chatter_user_name: chatMessage.chatter_user_name,
								badges_count: chatMessage.badges.length,
								message_length: chatMessage.message.text.length,
								user_permission: userPermission,
							});
							const parsed = parseCommand(messageText);
							if (!parsed) {
								webhookLogger.debug("Ignoring non-command chat message", {
									event: "webhook.twitch.chat_message.ignored",
									reason: "not_a_command",
									message_id: chatMessage.message_id,
								});
								break;
							}

							webhookLogger.info("Chat command parsed", {
								event: "webhook.twitch.chat_message.command_parsed",
								message_id: chatMessage.message_id,
								command: parsed.command,
								has_arg: parsed.arg !== null,
							});
							const commandsStub = getStub("COMMANDS_DO");
							const commandResult = await commandsStub.getCommand(parsed.command);

							if (commandResult.status === "error") {
								webhookLogger.error("Chat command lookup failed", {
									event: "webhook.twitch.chat_message.command_lookup_failed",
									message_id: chatMessage.message_id,
									command: parsed.command,
									...commandResult.error,
								});
								break;
							}

							if (!commandResult.value.enabled) {
								webhookLogger.debug("Ignoring disabled chat command", {
									event: "webhook.twitch.chat_message.ignored",
									reason: "disabled",
									message_id: chatMessage.message_id,
									command: parsed.command,
								});
								break;
							}

							if (!hasPermission(userPermission, commandResult.value.permission)) {
								webhookLogger.debug("Ignoring chat command due to permission", {
									event: "webhook.twitch.chat_message.ignored",
									reason: "permission_denied",
									message_id: chatMessage.message_id,
									command: parsed.command,
									user_permission: userPermission,
								});
								break;
							}

							try {
								await handleChatCommand(chatMessage, c.env, parsed, commandResult.value);
								webhookLogger.info("Chat command executed", {
									event: "webhook.twitch.chat_message.command_executed",
									message_id: chatMessage.message_id,
									command: parsed.command,
									response_type: commandResult.value.responseType,
								});
							} catch (error) {
								webhookLogger.error("Chat command failed", {
									event: "webhook.twitch.chat_message.command_failed",
									message_id: chatMessage.message_id,
									command: parsed.command,
									...normalizeError(error),
								});
							}
							break;
						}

						default: {
							webhookLogger.warn("Unhandled EventSub subscription type", {
								event: "webhook.twitch.notification.received",
								outcome: "unhandled_subscription_type",
								subscription_type: subscription.type,
							});
						}
					}
				} catch (error) {
					webhookLogger.error("Error processing EventSub notification", {
						event: "webhook.twitch.body_parse_failed",
						subscription_type: subscription.type,
						...normalizeError(error),
					});
				}

				return c.json({ success: true }, 200);
			}

			webhookLogger.warn("Unknown EventSub message type", {
				event: "webhook.twitch.headers_invalid",
				message_type: messageType,
				message_id: messageId,
			});
			return c.json({ error: "Unknown message type" }, 400);
		},
	);
});

export default webhooks;
