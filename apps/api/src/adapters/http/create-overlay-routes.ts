/**
 * Overlay routes for OBS/streaming overlays
 *
 * Provides HTML pages with transparent backgrounds for use in streaming software.
 */

import { Hono } from "hono";
import { html } from "hono/html";

import { type AppRouteEnv } from "../../lib/request-context";

import type { Logger } from "../../lib/logging";

/** Exact dependencies required by the Now Playing overlay route. */
export type OverlayRouteDependencies = Readonly<{ logger: Logger }>;

/** Creates the OBS Now Playing overlay route. */
export function createOverlayRoutes(
	dependencies: OverlayRouteDependencies,
): Hono<AppRouteEnv<object>> {
	const overlay = new Hono<AppRouteEnv<object>>();

	/**
	 * GET /overlay/now-playing
	 * HTML overlay showing currently playing track with transparent background
	 * Polls /api/now-playing every 5 seconds for updates
	 */
	overlay.get("/now-playing", (c) => {
		dependencies.logger.info("Served now playing overlay page", {
			event: "overlay.now_playing_page.served",
			component: "route",
			route: "/overlay/now-playing",
		});
		const overlayHtml = html`
		<!doctype html>
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Now Playing</title>
				<style>
					/* Catppuccin Macchiato theme colors */
					:root {
						--ctp-base: #24273a;
						--ctp-text: #cad3f5;
						--ctp-subtext: #b8c0e0;
						--ctp-pink: #f5bde6;
					}
		
					* {
						margin: 0;
						padding: 0;
						box-sizing: border-box;
					}
		
					body {
						background: transparent;
						font-family: "IBM Plex Mono", ui-monospace, monospace;
						color: var(--ctp-text);
						-webkit-font-smoothing: antialiased;
						-moz-osx-font-smoothing: grayscale;
					}
		
					.container {
						width: 320px;
						height: 120px;
						margin: 20px auto 0;
						background: var(--ctp-base);
						border-radius: 6px;
						padding: 8px;
						box-shadow:
							0 10px 15px -3px rgba(0, 0, 0, 0.1),
							0 4px 6px -4px rgba(0, 0, 0, 0.1);
						display: flex;
						align-items: center;
					}
		
					.container.empty-state {
						gap: 16px;
						padding: 16px 20px;
					}
		
					.album-art-container {
						width: 64px;
						height: 64px;
						flex-shrink: 0;
					}
		
					.container.empty-state .album-art-container {
						display: none;
					}
		
					.album-art {
						width: 64px;
						height: 64px;
						border-radius: 50%;
						object-fit: cover;
						animation: spin 5s linear infinite;
					}
		
					.album-art.hidden {
						visibility: hidden;
					}
		
					@keyframes spin {
						from {
							transform: rotate(0deg);
						}
						to {
							transform: rotate(360deg);
						}
					}
		
					.track-info {
						flex-grow: 1;
						min-width: 0;
						padding-left: 16px;
						display: flex;
						flex-direction: column;
						gap: 4px;
					}
		
					.container.empty-state .track-info {
						padding-left: 0;
						gap: 0;
					}
		
					.track-details {
						display: flex;
						flex-direction: column;
						gap: 4px;
					}
		
					.track-details.hidden {
						display: none;
					}
		
					.track-header {
						font-size: 16px;
						font-weight: 600;
						line-height: 1.5rem;
						min-height: 1.5rem;
					}
		
					.container.empty-state .track-header {
						min-height: 0;
						max-width: 18ch;
						line-height: 1.4;
						text-wrap: balance;
					}
		
					.track-name {
						font-size: 14px;
						line-height: 1.25rem;
						min-height: 1.25rem;
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
		
					.track-artist {
						font-size: 14px;
						line-height: 1.25rem;
						min-height: 1.25rem;
						color: var(--ctp-subtext);
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
		
					.track-requester {
						font-size: 14px;
						line-height: 1.25rem;
						min-height: 1.25rem;
						color: var(--ctp-subtext);
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
					}
		
					.music-icon {
						width: 56px;
						height: 56px;
						flex-shrink: 0;
						color: var(--ctp-pink);
					}
		
					.container.empty-state .music-icon {
						width: 48px;
						height: 48px;
					}
				</style>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
				<link
					href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
					rel="stylesheet"
				/>
			</head>
			<body>
				<div id="overlay" class="container">
					<div class="album-art-container">
						<img id="album-art" src="" alt="" class="album-art hidden" />
					</div>
					<div class="track-info">
						<h2 id="header" class="track-header">Loading...</h2>
						<div id="track-details" class="track-details">
							<p id="track-name" class="track-name">&nbsp;</p>
							<p id="track-artist" class="track-artist">&nbsp;</p>
							<p id="track-requester" class="track-requester">&nbsp;</p>
						</div>
					</div>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="music-icon"
					>
						<path d="M9 18V5l12-2v13"></path>
						<circle cx="6" cy="18" r="3"></circle>
						<circle cx="18" cy="16" r="3"></circle>
					</svg>
				</div>
		
				<script>
					const NOW_PLAYING_URL = "/api/now-playing";
					const QUEUE_URL = "/api/queue?limit=1";
					const POLL_INTERVAL_MS = 5000;
					const REQUEST_TIMEOUT_MS = 4000;

					let active = "currentlyPlaying";
					let pollInFlight = false;
					let currentState = { status: "loading" };
					let nextUpState = { status: "loading" };

					function parseTrack(input) {
						if (!input || typeof input !== "object") return null;
						if (typeof input.id !== "string" || typeof input.name !== "string") return null;
						if (!Array.isArray(input.artists)) return null;

						const artists = [];
						for (const artist of input.artists) {
							if (typeof artist === "string") {
								artists.push(artist);
							} else if (artist && typeof artist === "object" && typeof artist.name === "string") {
								artists.push(artist.name);
							} else {
								return null;
							}
						}

						for (const field of ["album", "albumCoverUrl", "requesterDisplayName"]) {
							if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string") {
								return null;
							}
						}

						return {
							id: input.id,
							name: input.name,
							artists,
							album: input.album || null,
							albumCoverUrl: input.albumCoverUrl || null,
							requesterDisplayName: input.requesterDisplayName || null,
						};
					}

					function parseNowPlayingResponse(input) {
						if (!input || typeof input !== "object" || !("track" in input)) return null;
						if (input.track === null) return { status: "empty" };
						const track = parseTrack(input.track);
						return track ? { status: "ready", track } : null;
					}

					function parseQueueResponse(input) {
						if (!input || typeof input !== "object" || !Array.isArray(input.tracks)) return null;
						if (input.tracks.length === 0) return { status: "empty" };
						const track = parseTrack(input.tracks[0]);
						return track ? { status: "ready", track } : null;
					}

					async function fetchOverlayState(url, parseResponse) {
						const controller = new AbortController();
						const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
						try {
							const response = await fetch(url, { signal: controller.signal });
							if (!response.ok) return { status: "error" };
							const parsed = parseResponse(await response.json());
							return parsed || { status: "error" };
						} catch (error) {
							console.error("Overlay endpoint request failed", url, error);
							return { status: "error" };
						} finally {
							clearTimeout(timeout);
						}
					}

					async function pollOverlayData() {
						if (pollInFlight) return;
						pollInFlight = true;
						try {
							const [latestCurrentState, latestNextUpState] = await Promise.all([
								fetchOverlayState(NOW_PLAYING_URL, parseNowPlayingResponse),
								fetchOverlayState(QUEUE_URL, parseQueueResponse),
							]);
							currentState = latestCurrentState;
							nextUpState = latestNextUpState;
							updateDisplay();
						} finally {
							pollInFlight = false;
						}
					}

					function updateDisplay() {
						const activeState = active === "currentlyPlaying" ? currentState : nextUpState;
						const overlayEl = document.getElementById("overlay");
						const headerEl = document.getElementById("header");
						const detailsEl = document.getElementById("track-details");
						const nameEl = document.getElementById("track-name");
						const artistEl = document.getElementById("track-artist");
						const requesterEl = document.getElementById("track-requester");
						const albumArt = document.getElementById("album-art");

						if (!overlayEl || !headerEl || !detailsEl || !nameEl || !artistEl || !requesterEl || !albumArt) return;

						if (activeState.status !== "ready") {
							overlayEl.classList.add("empty-state");
							detailsEl.classList.add("hidden");
							headerEl.textContent = activeState.status === "error"
								? active === "currentlyPlaying" ? "Now playing unavailable" : "Next up unavailable"
								: activeState.status === "loading" ? "Loading..." : "Nothing is currently playing";
							nameEl.innerHTML = "&nbsp;";
							artistEl.innerHTML = "&nbsp;";
							requesterEl.innerHTML = "&nbsp;";
							albumArt.classList.add("hidden");
							return;
						}

						overlayEl.classList.remove("empty-state");
						detailsEl.classList.remove("hidden");
						const track = activeState.track;
						headerEl.textContent = active === "currentlyPlaying" ? "Now Playing" : "Next Up";
						nameEl.textContent = track.name;
						artistEl.textContent = track.artists.join(", ");
						requesterEl.textContent = track.requesterDisplayName && track.requesterDisplayName !== "Unknown"
							? "Requested by @" + track.requesterDisplayName
							: "\u00a0";

						if (track.albumCoverUrl) {
							albumArt.src = track.albumCoverUrl;
							albumArt.alt = (track.album || track.name) + " album art";
							albumArt.classList.remove("hidden");
						} else {
							albumArt.classList.add("hidden");
						}
					}

					function toggleOverlayView() {
						if (currentState.status !== "ready") {
							active = "currentlyPlaying";
						} else if (active === "currentlyPlaying" && nextUpState.status === "ready") {
							active = "nextUp";
						} else {
							active = "currentlyPlaying";
						}
						updateDisplay();
					}

					void pollOverlayData();
					setInterval(() => {
						toggleOverlayView();
						void pollOverlayData();
					}, POLL_INTERVAL_MS);
				</script>
			</body>
		</html>
	`;

		return c.html(overlayHtml);
	});

	return overlay;
}
