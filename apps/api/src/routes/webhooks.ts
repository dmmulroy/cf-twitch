/**
 * Twitch EventSub Webhook Handler
 *
 * Receives and verifies EventSub webhook events from Twitch.
 * Handles challenge verification, signature validation, and event routing.
 */

import { Result } from "better-result";
import { Hono } from "hono";
import { z } from "zod";

import { type ChatCommandStatus, writeChatCommandMetric } from "../lib/analytics";
import { parseCommandWithArg } from "../lib/commands";
import { getStub } from "../lib/durable-objects";
import { CommandNotUpdateableError } from "../lib/errors";
import { logger } from "../lib/logger";
import { type Permission, getUserPermission, hasPermission } from "../lib/permissions";
import { TwitchService } from "../services/twitch-service";

import type { UnlockedAchievement } from "../durable-objects/achievements-do";
import type { Command } from "../durable-objects/schemas/commands-do.schema";
import type { LeaderboardEntry } from "../durable-objects/schemas/keyboard-raffle-do.schema";
import { UserStatsNotFoundError } from "../durable-objects/keyboard-raffle-do";
import type { QueuedTrack } from "../durable-objects/song-queue-do";
import type { Env } from "../index";

// =============================================================================
// Chat Command Handlers (migrated from ChatCommandWorkflow)
// =============================================================================

type StaticCommand = "keyboard" | "socials" | "dotfiles";
type DynamicInfoCommand = "today" | "project";
type MusicCommand = "song" | "queue";
type UpdateCommand = "update";
type ComputedCommand = "achievements" | "stats" | "raffle-leaderboard" | "commands";
type ChatCommand =
	| StaticCommand
	| DynamicInfoCommand
	| MusicCommand
	| UpdateCommand
	| ComputedCommand;

interface ParsedChatCommand {
	command: ChatCommand;
	arg: string | null;
}

function parseCommand(text: string): ParsedChatCommand | null {
	const parsed = parseCommandWithArg(text);
	if (!parsed) return null;

	// Validate command is a known ChatCommand
	const validCommands: ChatCommand[] = [
		"song",
		"queue",
		"keyboard",
		"socials",
		"dotfiles",
		"today",
		"project",
		"update",
		"achievements",
		"stats",
		"raffle-leaderboard",
		"commands",
	];

	if (!validCommands.includes(parsed.command as ChatCommand)) {
		return null;
	}

	return { command: parsed.command as ChatCommand, arg: parsed.arg };
}

async function handleSongCommand(): Promise<string> {
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getCurrentlyPlaying();

	if (result.status === "error") {
		logger.error("Failed to get currently playing", { error: result.error.message });
		return "Sorry, couldn't get the current song info.";
	}

	const { track } = result.value;
	if (!track) {
		return "No track currently playing.";
	}

	const artistStr = track.artists.join(", ");
	const attribution =
		track.requesterUserId === "unknown" ? "" : ` - requested by @${track.requesterDisplayName}`;

	return `Now playing: "${track.name}" by ${artistStr}${attribution}`;
}

async function handleQueueCommand(): Promise<string> {
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getQueue(4);

	if (result.status === "error") {
		logger.error("Failed to get queue", { error: result.error.message });
		return "Sorry, couldn't get the queue info.";
	}

	const { tracks } = result.value;
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

async function handleStaticCommand(command: StaticCommand): Promise<string> {
	const stub = getStub("COMMANDS_DO");
	const result = await stub.getCommandValue(command);

	if (result.status === "error") {
		logger.error("Failed to get command value", { command, error: result.error.message });
		return `Sorry, couldn't retrieve ${command} info.`;
	}

	const value = result.value;
	if (!value) {
		return `${command} info is not available.`;
	}

	return value;
}

/**
 * Handle dynamic info commands (!today, !project)
 *
 * Both read from "today" key via CommandsDO (project is an alias).
 */
async function handleDynamicInfoCommand(command: DynamicInfoCommand): Promise<string> {
	const stub = getStub("COMMANDS_DO");
	const result = await stub.getCommandValue(command);

	if (result.status === "error") {
		logger.error("Failed to get command value", { command, error: result.error.message });
		return "Sorry, couldn't retrieve today's topic.";
	}

	const value = result.value;
	if (!value) {
		return "No topic set for today.";
	}

	return `Working on: ${value}`;
}

/**
 * Handle !update command (mod+ only)
 *
 * Syntax: !update <command> <value>
 * Only dynamic commands (today) are updateable.
 */
async function handleUpdateCommand(
	arg: string | null,
	userPermission: Permission,
	userName: string,
): Promise<string> {
	// Check permission first
	if (!hasPermission(userPermission, "moderator")) {
		return "Only moderators can update commands.";
	}

	if (!arg) {
		return "Usage: !update today <value>";
	}

	// Parse: first word is command name, rest is value
	const parts = arg.split(/\s+/);
	const targetCommand = parts[0];
	const newValue = parts.slice(1).join(" ");

	if (!targetCommand) {
		return "Usage: !update today <value>";
	}

	if (!newValue) {
		return `Usage: !update ${targetCommand} <value>`;
	}

	const stub = getStub("COMMANDS_DO");
	const result = await stub.setCommandValue(targetCommand, newValue, userName);

	if (result.status === "error") {
		if (CommandNotUpdateableError.is(result.error)) {
			return `!${targetCommand} is not updateable.`;
		}
		logger.error("Failed to update command", {
			command: targetCommand,
			error: result.error.message,
		});
		return "Sorry, couldn't update the command.";
	}

	return `Updated !${targetCommand}`;
}

/**
 * Handle !achievements command
 *
 * Shows unlocked achievements for caller or specified user.
 * Format: "@user has unlocked X achievements: A, B, C" or "hasn't unlocked any"
 */
async function handleAchievementsCommand(
	arg: string | null,
	callerDisplayName: string,
): Promise<string> {
	const targetUser = arg ?? callerDisplayName;

	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUnlockedAchievements(targetUser);

	if (result.status === "error") {
		logger.error("Failed to get achievements", { user: targetUser, error: result.error.message });
		return `Sorry, couldn't retrieve achievements for @${targetUser}.`;
	}

	const achievements: UnlockedAchievement[] = result.value;

	if (achievements.length === 0) {
		return `@${targetUser} hasn't unlocked any achievements yet.`;
	}

	const names = achievements.map((a) => a.name).join(", ");
	return `@${targetUser} has unlocked ${achievements.length} achievement${achievements.length === 1 ? "" : "s"}: ${names}`;
}

/**
 * Handle !stats command
 *
 * Shows aggregated stats: songs requested, achievements unlocked, raffle participation.
 * For self: uses userId for song/raffle queries
 * For other user: uses displayName for lookups
 */
async function handleStatsCommand(
	arg: string | null,
	callerUserId: string,
	callerDisplayName: string,
): Promise<string> {
	const isSelf = arg === null;
	const targetUser = arg ?? callerDisplayName;

	// Get achievement stats (uses displayName)
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
		logger.warn("Failed to get achievement stats", { user: targetUser });
	}

	// Get raffle stats and song count in parallel
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

	// Parallel fetch of song count and raffle stats
	const [songResult, raffleResult] = await Promise.all([
		isSelf
			? songQueueStub.getUserRequestCount(callerUserId)
			: songQueueStub.getUserRequestCountByDisplayName(targetUser),
		isSelf
			? raffleStub.getUserStats(callerUserId)
			: raffleStub.getUserStatsByDisplayName(targetUser),
	]);

	// Process song count result
	let songCount = 0;
	if (songResult.status === "ok") {
		songCount = songResult.value;
	} else {
		// Only log actual errors, not "not found" scenarios
		logger.warn("Failed to get song count", {
			user: isSelf ? callerUserId : targetUser,
			error: songResult.error.message,
		});
	}

	// Process raffle stats result
	let raffleStats = "0 rolls";
	if (raffleResult.status === "ok") {
		raffleStats = formatRaffleStats(raffleResult.value);
	} else if (!UserStatsNotFoundError.is(raffleResult.error)) {
		// Log actual errors (not "user hasn't rolled" which is expected)
		logger.warn("Failed to get raffle stats", {
			user: isSelf ? callerUserId : targetUser,
			error: raffleResult.error.message,
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
		return `No records found for @${targetUser} yet — no songs, achievements, or raffle stats.`;
	}

	return `@${targetUser} — Songs: ${songCount} | Achievements: ${achievementStats} | Raffles: ${raffleStats}`;
}

/**
 * Handle !raffle-leaderboard command
 *
 * Shows top winners sorted by total wins.
 * Format: "Raffle wins: 1. @alice (5) 2. @bob (3) 3. @charlie (2)"
 */
async function handleRaffleLeaderboardCommand(): Promise<string> {
	const stub = getStub("KEYBOARD_RAFFLE_DO");
	const result = await stub.getLeaderboard({ sortBy: "wins", limit: 5 });

	if (result.status === "error") {
		logger.error("Failed to get raffle leaderboard", { error: result.error.message });
		return "Sorry, couldn't retrieve the raffle leaderboard.";
	}

	const entries: LeaderboardEntry[] = result.value;

	if (entries.length === 0) {
		return "No raffle rolls recorded yet.";
	}

	// Filter to only users with at least one win
	const winners = entries.filter((e) => e.totalWins > 0);

	if (winners.length === 0) {
		return "No raffle winners yet — be the first!";
	}

	const leaderboard = winners
		.map((e, idx) => `${idx + 1}. @${e.displayName} (${e.totalWins})`)
		.join(" ");

	return `Raffle wins: ${leaderboard}`;
}

/**
 * Handle !commands command
 *
 * Lists available commands based on user permission level.
 * Format: "Commands: !keyboard !socials ..." for everyone
 * Mods see: "Commands: ... | Mod: !update"
 */
async function handleCommandsCommand(userPermission: Permission): Promise<string> {
	const stub = getStub("COMMANDS_DO");
	const result = await stub.getCommandsByPermission(userPermission);

	if (result.status === "error") {
		logger.error("Failed to get commands", {
			error: result.error.message,
			permission: userPermission,
		});
		return "Sorry, couldn't retrieve the commands list.";
	}

	const commands: Command[] = result.value;

	if (commands.length === 0) {
		return "No commands available.";
	}

	// Separate commands by permission level
	const everyoneCommands = commands.filter((c: Command) => c.permission === "everyone");
	const modCommands = commands.filter((c: Command) => c.permission === "moderator");

	// Format everyone commands
	const everyoneList = everyoneCommands.map((c) => `!${c.name}`).join(" ");

	// If user has mod+ permission and there are mod commands, append them
	if (modCommands.length > 0 && hasPermission(userPermission, "moderator")) {
		const modList = modCommands.map((c) => `!${c.name}`).join(" ");
		return `Commands: ${everyoneList} | Mod: ${modList}`;
	}

	return `Commands: ${everyoneList}`;
}

async function handleChatCommand(
	chatMessage: z.infer<typeof ChatMessageEventSchema>,
	env: Env,
): Promise<void> {
	const parsed = parseCommand(chatMessage.message.text);
	if (!parsed) return;

	const { command, arg } = parsed;
	const startTime = Date.now();
	let status: ChatCommandStatus = "success";
	let error: string | undefined;

	logger.info("Processing chat command", {
		command,
		arg,
		user: chatMessage.chatter_user_name,
		messageId: chatMessage.message_id,
	});

	let responseMessage: string;
	const userPermission = getUserPermission(chatMessage.badges);

	switch (command) {
		case "song":
			responseMessage = await handleSongCommand();
			break;
		case "queue":
			responseMessage = await handleQueueCommand();
			break;
		case "keyboard":
		case "socials":
		case "dotfiles":
			responseMessage = await handleStaticCommand(command);
			break;
		case "today":
		case "project":
			responseMessage = await handleDynamicInfoCommand(command);
			break;
		case "update":
			responseMessage = await handleUpdateCommand(
				arg,
				userPermission,
				chatMessage.chatter_user_name,
			);
			break;
		case "achievements":
			responseMessage = await handleAchievementsCommand(arg, chatMessage.chatter_user_name);
			break;
		case "stats":
			responseMessage = await handleStatsCommand(
				arg,
				chatMessage.chatter_user_id,
				chatMessage.chatter_user_name,
			);
			break;
		case "raffle-leaderboard":
			responseMessage = await handleRaffleLeaderboardCommand();
			break;
		case "commands":
			responseMessage = await handleCommandsCommand(userPermission);
			break;
	}

	const twitchService = new TwitchService(env);
	const sendResult = await twitchService.sendChatMessage(responseMessage);

	if (sendResult.status === "error") {
		status = "error";
		error = sendResult.error.message;
		logger.warn("Failed to send chat response", {
			error: sendResult.error.message,
			command,
			messageId: chatMessage.message_id,
		});
	} else {
		logger.info("Chat response sent", { command, messageId: chatMessage.message_id });
	}

	// Emit chat command metric
	writeChatCommandMetric(env.ANALYTICS, {
		command,
		userId: chatMessage.chatter_user_id,
		userName: chatMessage.chatter_user_name,
		status,
		durationMs: Date.now() - startTime,
		error,
	});
}

const webhooks = new Hono<{ Bindings: Env }>();

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
	const headers = c.req.header();

	// Parse and validate EventSub headers
	const headersParsed = EventSubHeadersSchema.safeParse(headers);
	if (!headersParsed.success) {
		logger.error("Invalid EventSub headers", {
			error: headersParsed.error.message,
		});
		return c.json({ error: "Invalid headers" }, 400);
	}

	const {
		"twitch-eventsub-message-id": messageId,
		"twitch-eventsub-message-type": messageType,
		"twitch-eventsub-message-signature": signature,
		"twitch-eventsub-message-timestamp": timestamp,
		"twitch-eventsub-subscription-type": subscriptionType,
	} = headersParsed.data;

	// Verify timestamp (reject messages older than 10 minutes)
	if (!isTimestampValid(timestamp)) {
		logger.error("EventSub message timestamp too old", {
			timestamp,
			messageId,
		});
		return c.json({ error: "Message too old" }, 403);
	}

	// Get raw body for signature verification
	const rawBody = await c.req.text();

	// Verify signature
	const isValid = await verifySignature(
		c.env.TWITCH_EVENTSUB_SECRET,
		messageId,
		timestamp,
		rawBody,
		signature,
	);

	if (!isValid) {
		logger.error("EventSub signature verification failed", {
			messageId,
			subscriptionType,
		});
		return c.json({ error: "Invalid signature" }, 403);
	}

	// Parse body
	const bodyResult = Result.try({
		try: () => JSON.parse(rawBody) as unknown,
		catch: (e) => new Error(`Invalid JSON: ${String(e)}`),
	});

	if (bodyResult.status === "error") {
		logger.error("Failed to parse webhook body", { error: bodyResult.error.message });
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const body = bodyResult.value;

	// Handle challenge verification
	if (messageType === "webhook_callback_verification") {
		const parsed = EventSubChallengeSchema.safeParse(body);
		if (!parsed.success) {
			logger.error("Invalid challenge payload", {
				error: parsed.error.message,
			});
			return c.json({ error: "Invalid payload" }, 400);
		}

		logger.info("EventSub challenge received", {
			subscriptionId: parsed.data.subscription.id,
			type: parsed.data.subscription.type,
		});

		// Return the challenge
		return c.text(parsed.data.challenge, 200);
	}

	// Handle revocation
	if (messageType === "revocation") {
		logger.warn("EventSub subscription revoked", {
			subscriptionType,
			messageId,
		});
		return c.json({ success: true }, 200);
	}

	// Handle notification
	if (messageType === "notification") {
		const parsed = EventSubNotificationSchema.safeParse(body);
		if (!parsed.success) {
			logger.error("Invalid notification payload", {
				error: parsed.error.message,
			});
			return c.json({ error: "Invalid payload" }, 400);
		}

		const { subscription, event } = parsed.data;

		logger.info("EventSub notification received", {
			type: subscription.type,
			subscriptionId: subscription.id,
		});

		// Route events based on subscription type
		// AI: create smaller handler functions for handling each subscription type
		try {
			switch (subscription.type) {
				case "stream.online": {
					// Signal StreamLifecycleDO via RPC
					const stub = getStub("STREAM_LIFECYCLE_DO");
					await stub.onStreamOnline();
					logger.info("Stream online event processed");
					break;
				}

				case "stream.offline": {
					// Signal StreamLifecycleDO via RPC
					const stub = getStub("STREAM_LIFECYCLE_DO");
					await stub.onStreamOffline();
					logger.info("Stream offline event processed");
					break;
				}

				case "channel.channel_points_custom_reward_redemption.add": {
					// Parse and validate redemption event
					const redemptionResult = RedemptionEventSchema.safeParse(event);
					if (!redemptionResult.success) {
						logger.error("Invalid redemption event payload", {
							error: redemptionResult.error.message,
							messageId,
						});
						break;
					}
					const redemption = redemptionResult.data;
					const rewardId = redemption.reward.id;

					// Route to appropriate saga DO based on reward ID
					// Each saga instance is keyed by redemption ID for isolation
					if (c.env.SONG_REQUEST_REWARD_ID && rewardId === c.env.SONG_REQUEST_REWARD_ID) {
						const sagaId = c.env.SONG_REQUEST_SAGA_DO.idFromName(redemption.id);
						const stub = c.env.SONG_REQUEST_SAGA_DO.get(sagaId);
						const result = await stub.start(redemption);

						if (result.status === "error") {
							logger.error("Song request saga failed to start", {
								redemptionId: redemption.id,
								error: result.error.message,
							});
						} else {
							logger.info("Song request saga started", { redemptionId: redemption.id });
						}
					} else if (
						c.env.KEYBOARD_RAFFLE_REWARD_ID &&
						rewardId === c.env.KEYBOARD_RAFFLE_REWARD_ID
					) {
						const sagaId = c.env.KEYBOARD_RAFFLE_SAGA_DO.idFromName(redemption.id);
						const stub = c.env.KEYBOARD_RAFFLE_SAGA_DO.get(sagaId);
						const result = await stub.start(redemption);

						if (result.status === "error") {
							logger.error("Keyboard raffle saga failed to start", {
								redemptionId: redemption.id,
								error: result.error.message,
							});
						} else {
							logger.info("Keyboard raffle saga started", { redemptionId: redemption.id });
						}
					} else {
						logger.warn("Unknown reward ID, skipping redemption", {
							rewardId,
							rewardTitle: redemption.reward.title,
							messageId,
						});
					}
					break;
				}

				case "channel.chat.message": {
					// Parse and validate chat message event
					const chatResult = ChatMessageEventSchema.safeParse(event);
					if (!chatResult.success) {
						logger.error("Invalid chat message event payload", {
							error: chatResult.error.message,
							messageId,
						});
						break;
					}
					const chatMessage = chatResult.data;

					// Process chat commands
					const messageText = chatMessage.message.text.trim().toLowerCase();

					// Parse command and check CommandsDO registry (single source of truth)
					const parsed = parseCommand(messageText);
					if (parsed) {
						const commandsStub = getStub("COMMANDS_DO");
						const commandResult = await commandsStub.getCommand(parsed.command);

						if (commandResult.status === "ok" && commandResult.value.enabled) {
							const userPermission = getUserPermission(chatMessage.badges);
							if (hasPermission(userPermission, commandResult.value.permission)) {
								await handleChatCommand(chatMessage, c.env);
							}
						}
					}
					// Ignore other chat messages silently
					break;
				}

				default: {
					logger.warn("Unhandled EventSub subscription type", {
						type: subscription.type,
					});
				}
			}
		} catch (error) {
			logger.error("Error processing EventSub notification", {
				type: subscription.type,
				error: error instanceof Error ? error.message : String(error),
			});
			// Still return 200 to avoid retries for transient errors
		}

		// Return 200 to acknowledge receipt
		return c.json({ success: true }, 200);
	}

	// Unknown message type
	logger.warn("Unknown EventSub message type", {
		messageType,
		messageId,
	});
	return c.json({ error: "Unknown message type" }, 400);
});

export default webhooks;
