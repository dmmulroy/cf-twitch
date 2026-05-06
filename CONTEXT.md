# CF Twitch

CF Twitch is a Twitch stream integration for channel-point interactions, Spotify-backed song requests, keyboard raffles, stream lifecycle tracking, and viewer achievements.

## Language

**Viewer**:
A Twitch user participating in the stream through chat, channel-point redemptions, song requests, raffles, or achievements.
_Avoid_: Customer, requester as a general user term

**Channel Point Redemption**:
A Twitch reward redemption submitted by a **Viewer** that starts a domain flow such as a **Song Request** or **Keyboard Raffle**.
_Avoid_: Purchase, payment, transaction

**Song Request**:
A channel-point redemption where a **Viewer** submits a Spotify track URL to be added to the stream's playback queue.
_Avoid_: Music request, track submission

**Spotify Track**:
The specific Spotify song identified by a **Song Request**, including its track id, title, artists, album, and artwork.
_Avoid_: Song when referring to the Spotify entity

**Spotify Queue**:
The playback queue managed by Spotify for the stream, including the currently playing track and upcoming tracks.
_Avoid_: Request queue when referring to Spotify playback state

**Pending Request**:
A **Song Request** that has been accepted and attributed to a **Viewer** but has not yet been confirmed as played or removed.
_Avoid_: Pending song, unplayed history item

**Request History**:
The permanent record of **Song Requests** that were fulfilled by being confirmed as played.
_Avoid_: Audit log when referring specifically to fulfilled song requests

**Now Playing**:
The **Spotify Track** currently playing on stream.
_Avoid_: Current song if Spotify attribution matters

**Chat Command**:
A Twitch chat message that asks the integration to respond with stream state such as **Now Playing** or the upcoming **Spotify Queue**.
_Avoid_: Slash command, bot command when the trigger is Twitch chat text

**Keyboard Raffle**:
A channel-point redemption where a **Viewer** rolls a number for a chance to exactly match a generated winning number.
_Avoid_: Lottery unless explaining informally

**Roll**:
A single **Keyboard Raffle** attempt by a **Viewer**, with a viewer number, winning number, distance, and win status.
_Avoid_: Ticket, entry

**Winning Number**:
The target number for a **Roll** that must be matched exactly for the **Viewer** to win.
_Avoid_: Jackpot number

**Distance**:
The absolute difference between a **Roll**'s viewer number and its **Winning Number**.
_Avoid_: Score when referring to raffle closeness

**Raffle Leaderboard**:
A ranking of **Viewers** by raffle participation, wins, and closest rolls.
_Avoid_: Scoreboard when referring to persisted raffle standings

**Achievement**:
A named milestone a **Viewer** can unlock through song requests, raffles, stream-session behavior, or engagement streaks.
_Avoid_: Badge unless referring only to presentation

**Achievement Progress**:
A **Viewer**'s accumulated or session-scoped progress toward unlocking an **Achievement**.
_Avoid_: Points, XP

**Request Streak**:
A session-scoped count of consecutive successful **Song Requests** by a **Viewer**.
_Avoid_: Song streak without specifying requests

**Stream Session**:
The period between the stream going online and offline, used to reset session-scoped achievements and streaks.
_Avoid_: Broadcast if the lifecycle boundary matters

**Stream Lifecycle State**:
The integration's current evidence about whether a **Stream Session** is active, when it started or ended, and its peak viewer count.
_Avoid_: Stream status when lifecycle evidence or session boundaries matter

**Stream Opener**:
The **Viewer** whose **Song Request** is first in a **Stream Session**.
_Avoid_: First requester unless the stream-session achievement is not relevant

## Relationships

- A **Viewer** creates zero or more **Channel Point Redemptions**.
- A **Channel Point Redemption** starts exactly one **Song Request** or one **Keyboard Raffle** flow.
- A **Song Request** belongs to exactly one **Viewer** and targets exactly one **Spotify Track**.
- A **Pending Request** is created from one **Song Request** and eventually becomes part of **Request History** when confirmed as played.
- The **Spotify Queue** may contain **Spotify Tracks** from **Pending Requests** and tracks from Spotify autoplay.
- **Now Playing** is position zero of the current **Spotify Queue** view.
- A **Keyboard Raffle** produces exactly one **Roll** per redemption.
- A **Roll** belongs to exactly one **Viewer** and has exactly one **Winning Number**.
- A **Distance** of zero means the **Roll** is a win.
- A **Raffle Leaderboard** is computed from many **Rolls**.
- An **Achievement** can be cumulative across all time or scoped to a single **Stream Session**.
- **Achievement Progress** belongs to one **Viewer** and one **Achievement**.
- **Stream Lifecycle State** records whether there is an active **Stream Session**.
- A **Stream Session** can have at most one **Stream Opener**.

## Example dialogue

> **Dev:** "When a **Viewer** submits a **Song Request**, do we put it straight into **Request History**?"
> **Domain expert:** "No — it starts as a **Pending Request**. It only becomes **Request History** once the **Spotify Track** is confirmed as played."
>
> **Dev:** "For a **Keyboard Raffle**, is there one stream-wide **Winning Number**?"
> **Domain expert:** "No — each **Roll** has its own **Winning Number**. A win requires that roll's viewer number to match exactly, giving a **Distance** of zero."
>
> **Dev:** "Does **Stream Opener** mean the first chatter?"
> **Domain expert:** "No — it means the **Viewer** with the first **Song Request** in the current **Stream Session**."

## Flagged ambiguities

- "Queue" can mean **Spotify Queue** or **Pending Request** storage; use **Spotify Queue** for playback state and **Pending Request** for accepted-but-unplayed song requests.
- "Song" is acceptable in user-facing copy, but use **Spotify Track** when referring to the Spotify entity stored or sent to Spotify APIs.
- "Winner" in the raffle means a **Roll** with **Distance** zero, not merely the closest roll on the **Raffle Leaderboard**.
