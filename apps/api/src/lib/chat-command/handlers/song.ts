import { Result } from "better-result";

import { chatTextResponse } from "../types";

import type { SongQueueReader } from "../../../capabilities/song-queue";
import type { QueuedTrack } from "../../../domain/spotify-queue";
import type { ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for the currently playing song.
 */
export class SongCommandHandler implements ComputedCommandHandler {
	constructor(private readonly songQueue: SongQueueReader) {}

	/**
	 * Report the currently playing song and requester attribution when available.
	 *
	 * @returns A Result containing a chat response with the current song details.
	 */
	async handle() {
		const result = await this.songQueue.getNowPlaying();
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't get the current song info."));
		}

		const { track } = result.value;
		if (!track) {
			return Result.ok(chatTextResponse("No track currently playing."));
		}

		const attribution =
			track.source === "autoplay" ? "" : ` - requested by @${track.requesterDisplayName}`;
		return Result.ok(
			chatTextResponse(`Now playing: "${track.name}" by ${track.artists.join(", ")}${attribution}`),
		);
	}
}

/**
 * Computed chat command handler for the song request queue.
 */
export class QueueCommandHandler implements ComputedCommandHandler {
	constructor(private readonly songQueue: SongQueueReader) {}

	/**
	 * Report the next requested songs in the queue.
	 *
	 * @returns A Result containing a chat response with the next queued tracks.
	 */
	async handle() {
		const result = await this.songQueue.getSpotifyQueue(4);
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't get the queue info."));
		}

		const { tracks } = result.value;
		if (tracks.length === 0) {
			return Result.ok(chatTextResponse("Queue is empty."));
		}

		const trackLines = tracks.map((track: QueuedTrack, idx: number) => {
			const requester = track.source === "autoplay" ? "" : ` (@${track.requesterDisplayName})`;
			return `${idx + 1}. "${track.name}" by ${track.artists.join(", ")}${requester}`;
		});

		return Result.ok(chatTextResponse(`Next up: ${trackLines.join(" | ")}`));
	}
}
