import { Result } from "better-result";

import { getSongQueue } from "../../song-queue-client";
import { chatTextResponse } from "../types";

import type { QueuedTrack } from "../../../durable-objects/song-queue-do";
import type { ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for the currently playing song.
 */
export class SongCommandHandler implements ComputedCommandHandler {
	/**
	 * Report the currently playing song and requester attribution when available.
	 *
	 * @returns A Result containing a chat response with the current song details.
	 */
	async handle() {
		using songQueue = await getSongQueue();
		const result = await songQueue.getCurrentlyPlaying();
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't get the current song info."));
		}

		const { track } = result.value;
		if (!track) {
			return Result.ok(chatTextResponse("No track currently playing."));
		}

		const attribution =
			track.requesterUserId === "unknown" ? "" : ` - requested by @${track.requesterDisplayName}`;
		return Result.ok(
			chatTextResponse(`Now playing: "${track.name}" by ${track.artists.join(", ")}${attribution}`),
		);
	}
}

/**
 * Computed chat command handler for the song request queue.
 */
export class QueueCommandHandler implements ComputedCommandHandler {
	/**
	 * Report the next requested songs in the queue.
	 *
	 * @returns A Result containing a chat response with the next queued tracks.
	 */
	async handle() {
		using songQueue = await getSongQueue();
		const result = await songQueue.getSongQueue(4);
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't get the queue info."));
		}

		const { tracks } = result.value;
		if (tracks.length === 0) {
			return Result.ok(chatTextResponse("Queue is empty."));
		}

		const trackLines = tracks.map((track: QueuedTrack, idx: number) => {
			const requester =
				track.requesterUserId === "unknown" ? "" : ` (@${track.requesterDisplayName})`;
			return `${idx + 1}. "${track.name}" by ${track.artists.join(", ")}${requester}`;
		});

		return Result.ok(chatTextResponse(`Next up: ${trackLines.join(" | ")}`));
	}
}
