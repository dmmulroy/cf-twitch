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
						font-family:
							-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
						color: var(--ctp-text);
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
		
					.album-art {
						width: 64px;
						height: 64px;
						border-radius: 50%;
						flex-shrink: 0;
						object-fit: cover;
						animation: spin 3s linear infinite;
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
						padding-left: 16px;
						display: flex;
						flex-direction: column;
						gap: 4px;
					}
		
					.track-header {
						font-size: 14px;
						font-weight: 600;
					}
		
					.track-name {
						font-size: 12px;
					}
		
					.track-artist {
						font-size: 12px;
						color: var(--ctp-subtext);
					}
		
					.track-requester {
						font-size: 12px;
						color: var(--ctp-subtext);
					}
		
					.music-icon {
						width: 56px;
						margin-left: auto;
						color: var(--ctp-pink);
					}
				</style>
			</head>
			<body>
				<div class="container">
					<div id="album-art-container"></div>
					<div class="track-info">
						<h2 id="header" class="track-header">Loading...</h2>
						<p id="track-name" class="track-name"></p>
						<p id="track-artist" class="track-artist"></p>
						<p id="track-requester" class="track-requester"></p>
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
					const API_URL = "/api/now-playing";
					const TOGGLE_INTERVAL = 5000;
		
					let active = "currentlyPlaying";
					let currentData = null;
					let nextUpData = null;
		
					async function fetchData() {
						try {
							const response = await fetch(API_URL);
							if (!response.ok) {
								throw new Error(\`HTTP error! status: \${response.status}\`);
							}
							const data = await response.json();
							currentData = data.currentlyPlaying || null;
							nextUpData = data.nextUp || null;
							updateDisplay();
						} catch (error) {
							console.error("Failed to fetch now playing:", error);
						}
					}
		
					function updateDisplay() {
						const activeData = active === "currentlyPlaying" ? currentData : nextUpData;
						const headerEl = document.getElementById("header");
						const nameEl = document.getElementById("track-name");
						const artistEl = document.getElementById("track-artist");
						const requesterEl = document.getElementById("track-requester");
						const albumContainer = document.getElementById("album-art-container");
		
						if (!activeData) {
							headerEl.textContent = "Nothing is currently playing";
							nameEl.textContent = "";
							artistEl.textContent = "";
							requesterEl.textContent = "";
							albumContainer.innerHTML = "";
							return;
						}
		
						headerEl.textContent = active === "currentlyPlaying" ? "Now Playing" : "Next Up";
						nameEl.textContent = activeData.track?.name || "";
						artistEl.textContent = activeData.track?.artists?.map(a => a.name).join(", ") || "";
		
						if (activeData.requesterDisplayName) {
							requesterEl.textContent = \`Requested by @\${activeData.requesterDisplayName}\`;
						} else {
							requesterEl.textContent = "";
						}
		
						const albumUrl = activeData.track?.album?.images?.[0]?.url;
						if (albumUrl) {
							albumContainer.innerHTML = \`<img src="\${escapeAttr(albumUrl)}" alt="Album Art" class="album-art" />\`;
						} else {
							albumContainer.innerHTML = "";
						}
					}
		
					function escapeAttr(text) {
						const div = document.createElement("div");
						div.textContent = text;
						return div.innerHTML;
					}
		
					function toggle() {
						if (active === "currentlyPlaying") {
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
