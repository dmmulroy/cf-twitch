/**
 * ChatCommandWorkflow - Handles !song and !queue chat commands
 *
 * Simple workflow that responds to chat commands with queue information.
 *
 * Commands:
 * - !song: Get currently playing track with requester attribution
 * - !queue: Get next 4 tracks with requester/organic attribution
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { getStub } from "../lib/durable-objects";
import { casesHandled } from "../lib/exhaustive";
import { logger } from "../lib/logger";
import { waitForActivation } from "../lib/warm-workflow";
import { TwitchService } from "../services/twitch-service";

import type { QueuedTrack } from "../durable-objects/song-queue-do";
import type { Env } from "../index";

/**
 * Params passed from queue consumer (ChatMessageEventSchema)
 */
export interface ChatCommandParams {
	broadcaster_user_id: string;
	broadcaster_user_login: string;
	broadcaster_user_name: string;
	chatter_user_id: string;
	chatter_user_login: string;
	chatter_user_name: string;
	message_id: string;
	message: {
		text: string;
		fragments: Array<{
			type: string;
			text: string;
			cheermote: unknown;
			emote: unknown;
			mention: unknown;
		}>;
	};
}

/**
 * Supported chat commands
 */
type ChatCommand = "song" | "queue";

/**
 * Parse chat command from message text
 * Returns null if not a supported command
 */
function parseCommand(text: string): ChatCommand | null {
	const trimmed = text.trim().toLowerCase();

	if (trimmed === "!song") {
		return "song";
	}

	if (trimmed === "!queue") {
		return "queue";
	}

	return null;
}

/**
 * ChatCommandWorkflow - WorkflowEntrypoint for chat commands
 *
 * Supports warm pool pattern: instances can be pre-created with undefined payload
 * and wait at step.waitForEvent("activate") until activated with actual params.
 */
export class ChatCommandWorkflow extends WorkflowEntrypoint<Env, ChatCommandParams | undefined> {
	override async run(
		event: WorkflowEvent<ChatCommandParams | undefined>,
		step: WorkflowStep,
	): Promise<void> {
		// Wait for activation if this is a warm instance (undefined payload)
		// or use initial payload directly for cold starts
		// NOTE: This workflow doesn't use RollbackContext so we can use step directly
		const params = await waitForActivation(step, event.payload);

		// Step 1: Parse command (validation)
		const command = await step.do("parse-command", async () => {
			const cmd = parseCommand(params.message.text);
			if (!cmd) {
				throw new NonRetryableError(`Unknown command: ${params.message.text}`);
			}
			logger.info("Parsed chat command", { command: cmd, user: params.chatter_user_name });
			return cmd;
		});

		// Step 2: Handle command and generate response
		const responseMessage = await step.do(
			"handle-command",
			{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
			async () => {
				if (command === "song") {
					return this.handleSongCommand();
				}

				if (command === "queue") {
					return this.handleQueueCommand();
				}

				return casesHandled(command);
			},
		);

		// Step 3: Send chat response
		await step.do(
			"send-response",
			{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
			async () => {
				const twitchService = new TwitchService(this.env);
				const result = await twitchService.sendChatMessage(responseMessage);

				if (result.status === "error") {
					logger.error("Failed to send chat response", {
						error: result.error.message,
						command,
					});
					throw new Error(result.error.message);
				}

				logger.info("Sent chat response", { command, message: responseMessage });
			},
		);

		logger.info("Chat command workflow completed", {
			eventId: event.instanceId,
			command,
		});
	}

	/**
	 * Handle !song command - get currently playing track
	 */
	private async handleSongCommand(): Promise<string> {
		const stub = getStub("SONG_QUEUE_DO");
		const result = await stub.getCurrentlyPlaying();

		if (result.status === "error") {
			logger.error("Failed to get currently playing", { error: result.error.message });
			throw new Error(result.error.message);
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

	/**
	 * Handle !queue command - get next 4 tracks
	 */
	private async handleQueueCommand(): Promise<string> {
		const stub = getStub("SONG_QUEUE_DO");
		const result = await stub.getQueue(4);

		if (result.status === "error") {
			logger.error("Failed to get queue", { error: result.error.message });
			throw new Error(result.error.message);
		}

		const { tracks } = result.value;

		if (tracks.length === 0) {
			return "Queue is empty.";
		}

		// Format tracks with position and attribution
		const trackLines = tracks.map((track: QueuedTrack, idx: number) => {
			const requester =
				track.requesterUserId === "unknown" ? "" : (` (@${track.requesterDisplayName})` as const);
			return `${idx + 1}. "${track.name}" by ${track.artists.join(", ")}` + `(${requester})`;
		});

		return `Next up: ${trackLines.join(" | ")}`;
	}
}
