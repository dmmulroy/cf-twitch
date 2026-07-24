/**
 * Profile route for viewers to see their stats
 *
 * Provides HTML page per user with the stream stats
 */

import { Hono } from "hono";
import { html } from "hono/html";

import { logger } from "../lib/logger";
import { type AppRouteEnv } from "../lib/request-context";

import type { Env } from "../index";

const profile = new Hono<AppRouteEnv<Env>>();

/**
 * GET /profile/:username
 * HTML overlay showing user's stream stats based on their username
 */
profile.get("/:username", (c) => {
	logger.info("Served user profile page", {
		event: "profile.stats.served",
		component: "route",
		route: `/profile/${c.req.param("username")}`,
	});
	const username = c.req.param("username");
	const profileHtml = html`
		<!doctype html>
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>${username}'s stats</title>
				<style>
					/* Catppuccin Macchiato theme colors */
					:root {
						--ctp-base: #24273a;
						--ctp-text: #cad3f5;
            --ctp-green: #a6da95;
            --ctp-blue: #8aadf4;
						--ctp-subtext-1: #b8c0e0;
            --ctp-surface-0: #363a4f;
            --ctp-surface-1: #5b6078;
            --ctp-overlay-0: #6e738d;
					}
		
					* {
						margin: 0;
						padding: 0;
						box-sizing: border-box;
					}
		
					body {
            background: var(--ctp-base);
						font-family: "IBM Plex Mono", ui-monospace, monospace;
						color: var(--ctp-text);
						-webkit-font-smoothing: antialiased;
						-moz-osx-font-smoothing: grayscale;
					}

          main {
            width: min(1200px, calc(100% - 64px));
            margin-inline: auto;
            height: 100vh;
            display: flex;
            flex-direction: column;
          }

          header {
            display: flex;
            flex-direction: column;
            gap: 1rem;
            text-align: center;
            margin: 2rem 0;
          }

          footer {
            text-align: center;
            margin: 1rem 0;
          }

          footer a {
            color: var(--ctp-blue);
          }

          .card {
            background: var(--ctp-surface-0);
            border: 1px solid var(--ctp-overlay-0);
            border-radius: 18px;
          }

          .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 24px;
            margin-bottom: 24px;
          }

          .stat-card {
            padding: 28px;
          }

          .stat-card span {
            color: var(--ctp-subtext-1);
            display: block;
            margin-bottom: 8px;
          }

          .stat-card h2 {
            font-size: 2rem;
          }

          .content-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            flex: 1;
            min-height: 0;
          }

          .panel {
            overflow: scroll;
            padding: 24px;
            min-height: 0;
            overscroll-behavior: none;
          }

          .panel h2 {
            margin-bottom: 24px;
          }

          .achievement {
            background: var(--ctp-surface-1);
            border-radius: 14px;
            padding: 18px;
            margin-bottom: 16px;
          }

          .achievement p {
            color: var(--ctp-subtext-1);
            margin-top: 8px;
          }

          .song {
            background: var(--ctp-surface-1);
            border-radius: 14px;
            padding: 18px;
            margin-bottom: 16px;
          }

          .completed {
            border: 2px solid var(--ctp-green);
          }

          @media (max-width: 1000px) {
            .stats-grid {
              grid-template-columns: repeat(2, 1fr);
            }

            .content-grid {
              grid-template-columns: 1fr;
            }
          }

          @media (max-width: 700px) {
            main {
              width: calc(100% - 32px);
              overflow: scroll;
            }

            .stats-grid {
              grid-template-columns: 1fr;
            }
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
        <main>
          <header>
            <h1>${username}</h1>
            <p>Stream stats & achievements</p>
          </header>

          <section class="stats-grid">
            <div class="card stat-card song-request-counter">
              <span>Song Requests</span>
              <h2></h2>
            </div>

            <div class="card stat-card">
              <span>Achievements</span>
              <h2 class="achievement-count"></h2>
            </div>

            <div class="card stat-card">
              <span>Achievement Rate</span>
              <h2 id="achievement-rate"></h2>
            </div>
          </section>

          <section class="content-grid">
            <div id="achievement-wrapper" class="card panel">
              <h2>Achievements</h2>
            </div>

            <div id="song-request-wrapper" class="card panel">
              <h2>Top Song Requests</h2>
            </div>
          </section>
          <footer>
            <p>Your stats from <a href="https://twitch.tv/dillon" target="_blank" rel="noopener noreferrer">dmmulroy's</a> stream.</p>
          </footer>
        </main>
				<script>
					const USER_ACHIEVEMENTS_URL = "/api/achievements/${username}/unlocked";
          const USER_TOP_TRACKS_URL = "/api/stats/top-tracks/175222441?limit=5"; // TODO: Should be switched to username or some logic to find the user id

          let achievementData = null;
          let topTracksData = null;
		
					async function fetchData() {
						try {
							const [achievementsRes, topTracksRes] = await Promise.all([
								fetch(USER_ACHIEVEMENTS_URL),
                fetch(USER_TOP_TRACKS_URL)
							]);
		
							if (achievementsRes.ok) {
								achievementData = await achievementsRes.json();
							}

              if (topTracksRes.ok) {
                topTracksData = await topTracksRes.json();
              }
		
							updateDisplay();
						} catch (error) {
							console.error("Failed to fetch profile data:", error);
						}
					}
		
					function updateDisplay() {
            const achievementWrapper = document.querySelector("#achievement-wrapper");
            const achievementRate = document.querySelector("#achievement-rate");
            const achievementCounters = document.querySelectorAll(".achievement-count");

            const songRequestWrapper = document.querySelector("#song-request-wrapper");
            const songRequestCounters = document.querySelectorAll(".song-request-counter");

            const completedAchievements = achievementData.filter(a => a.unlocked === true).length;
            const totalAchievements = achievementData.length;

            achievementRate.textContent = Math.round((completedAchievements / totalAchievements) * 100) + "%";

            achievementData = achievementData.sort((a, b) => {
              if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
              if (a.unlocked && b.unlocked) return new Date(b.unlockedAt) - new Date(a.unlockedAt);
              if (!a.threshold && !b.threshold) return 0;
              if (!a.threshold) return 1;
              if (!b.threshold) return -1;
              return (b.progress / b.threshold) - (a.progress / a.threshold)
            });

            let achievementHtml = "";
            for (const achievement of achievementData) {
              if (achievement.unlocked) {
                achievementHtml +=
                  '<div class="achievement completed">' +
                  '<h3>' + achievement.name + '</h3>' +
                  '<p>' + achievement.description + '</p>' +
                    '<p>Unlocked: ' + new Date(achievement.unlockedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric"}) + '</p>' +
                '</div>';
              } else {
                achievementHtml +=
                  '<div class="achievement">' +
                  '<h3>' + achievement.name + '</h3>' +
                  '<p>' + achievement.description + '</p>' +
                  '<p>' + (achievement.threshold ? 'Progress: ' + achievement.progress + '/' + achievement.threshold : "One-time event") + '</p>' +
                '</div>';
              }
            }

            achievementWrapper.insertAdjacentHTML("beforeend", achievementHtml);

            for (const counter of achievementCounters) {
              counter.textContent = completedAchievements + "/" + totalAchievements;
            }

            let topTracksHtml = "";
            for (const song of topTracksData) {
              topTracksHtml +=
                '<div class="song">' +
                  '<h3>' + song.artists.join(", ") + ' - ' + song.trackName + '</h3>' +
                  '<p>Times requested: ' + song.requestCount + '</p>' +
                '</div>'
            }

            songRequestWrapper.insertAdjacentHTML("beforeend", topTracksHtml);

            for (const counter of songRequestCounters) {
              const textElement = counter.querySelector("h2");
              textElement.textContent = topTracksData.length;
            }
					}
		
					fetchData();
				</script>
			</body>
		</html>
	`;

	return c.html(profileHtml);
});

export default profile;
