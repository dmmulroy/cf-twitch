/**
 * Overlay routes for OBS/streaming overlays
 *
 * Provides HTML pages with transparent backgrounds for use in streaming software.
 */

import { Hono } from "hono";
import { html } from "hono/html";

import type { Env } from "../index";

const overlay = new Hono<{ Bindings: Env }>();

/**
 * GET /overlay/now-playing
 * HTML overlay showing currently playing track with transparent background
 * Polls /api/now-playing every 5 seconds for updates
 */
overlay.get("/now-playing", (c) => {
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
					const TOGGLE_INTERVAL = 5000;
		
					let active = "currentlyPlaying";
					let currentData = null;
					let nextUpData = null;
		
					async function fetchData() {
						try {
							const [nowPlayingRes, queueRes] = await Promise.all([
								fetch(NOW_PLAYING_URL),
								fetch(QUEUE_URL),
							]);
		
							if (nowPlayingRes.ok) {
								const data = await nowPlayingRes.json();
								currentData = data.track ? data : null;
							}
		
							if (queueRes.ok) {
								const queue = await queueRes.json();
								nextUpData = queue.tracks?.[0] ? { track: queue.tracks[0] } : null;
							}
		
							updateDisplay();
						} catch (error) {
							console.error("Failed to fetch now playing:", error);
						}
					}
		
					function updateDisplay() {
						const activeData = active === "currentlyPlaying" ? currentData : nextUpData;
						const overlayEl = document.getElementById("overlay");
						const headerEl = document.getElementById("header");
						const detailsEl = document.getElementById("track-details");
						const nameEl = document.getElementById("track-name");
						const artistEl = document.getElementById("track-artist");
						const requesterEl = document.getElementById("track-requester");
						const albumArt = document.getElementById("album-art");
		
						if (
							!overlayEl ||
							!headerEl ||
							!detailsEl ||
							!nameEl ||
							!artistEl ||
							!requesterEl ||
							!albumArt
						) {
							return;
						}
		
						if (!activeData?.track) {
							overlayEl.classList.add("empty-state");
							detailsEl.classList.add("hidden");
							headerEl.textContent = "Nothing is currently playing";
							nameEl.innerHTML = "&nbsp;";
							artistEl.innerHTML = "&nbsp;";
							requesterEl.innerHTML = "&nbsp;";
							albumArt.classList.add("hidden");
							return;
						}
		
						overlayEl.classList.remove("empty-state");
						detailsEl.classList.remove("hidden");
		
						const track = activeData.track;
						headerEl.textContent = active === "currentlyPlaying" ? "Now Playing" : "Next Up";
						nameEl.textContent = track.name || "";
						artistEl.textContent = Array.isArray(track.artists)
							? track.artists
									.map((artist) => (typeof artist === "string" ? artist : artist.name))
									.join(", ")
							: "";
		
						const requester = track.requesterDisplayName || activeData.requesterDisplayName;
						if (requester && requester !== "Unknown") {
							requesterEl.textContent = "Requested by @" + requester;
						} else {
							requesterEl.innerHTML = "&nbsp;";
						}
		
						const albumUrl = track.albumCoverUrl;
						if (albumUrl) {
							albumArt.src = albumUrl;
							albumArt.alt = (track.album || track.name || "Track") + " album art";
							albumArt.classList.remove("hidden");
						} else {
							albumArt.classList.add("hidden");
						}
					}
		
					function toggle() {
						const hasCurrentlyPlaying = Boolean(currentData?.track);
						const hasNextUp = Boolean(nextUpData?.track);
		
						if (!hasCurrentlyPlaying) {
							active = "currentlyPlaying";
							fetchData();
							return;
						}
		
						if (active === "currentlyPlaying") {
							if (!hasNextUp) {
								fetchData();
								return;
							}
		
							active = "nextUp";
							updateDisplay();
						} else {
							active = "currentlyPlaying";
							fetchData();
						}
					}
		
					fetchData();
					setInterval(toggle, TOGGLE_INTERVAL);
				</script>
			</body>
		</html>
	`;

	return c.html(overlayHtml);
});

export default overlay;
