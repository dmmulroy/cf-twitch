# CF Twitch

CF Twitch connects a Twitch stream's channel-point interactions, chat, Spotify playback, keyboard raffles, and viewer achievements.

## Viewers and redemptions

**Viewer**:
A Twitch user participating through chat, channel-point redemptions, or stream activities. Their Twitch identity stays the same when their display name changes.
_Avoid_: Customer, requester as a general user term

**Channel Point Redemption**:
A Viewer spending Twitch channel points on a configured reward. Recognized rewards start a Song Request or Keyboard Raffle; unrelated rewards do not.
_Avoid_: Purchase, payment, transaction

**Redemption Fulfillment**:
Confirmation to Twitch that a Channel Point Redemption's reward has been delivered. Song Request fulfillment does not mean its Spotify Track has played.
_Avoid_: Playback confirmation

**Refund**:
Confirmed cancellation of a Channel Point Redemption that returns its channel points. An attempted cancellation or unresolved outcome is not a refund.
_Avoid_: Compensation when referring only to the returned points

**Chat Command**:
A Twitch chat instruction that reads stream information or changes a permitted command value or counter.
_Avoid_: Slash command

## Song requests and playback

**Song Request**:
A Channel Point Redemption in which a Viewer submits a Spotify track link or URI for stream playback.
_Avoid_: Music request, track submission

**Spotify Track**:
The Spotify song identified by a stable track ID, with title, artists, album, and artwork.
_Avoid_: Song when referring to the provider entity

**Spotify Queue**:
Spotify's current playback and upcoming tracks, including requested tracks and autoplay.
_Avoid_: Request queue when referring to provider playback

**Queue Occurrence**:
One appearance of a Spotify Track in playback or the upcoming Spotify Queue. Two appearances of the same track are different occurrences and may belong to different Viewers.
_Avoid_: Track ID when distinguishing repeated appearances

**Pending Request**:
An accepted Song Request not yet confirmed as played or removed. It can survive temporary absence from the observed Spotify Queue.
_Avoid_: Unplayed history item

**Request History**:
The record of attributed Song Requests confirmed as played when their Queue Occurrence leaves current playback.
_Avoid_: Redemption history, fulfilled redemptions

**Now Playing**:
The currently playing Queue Occurrence, with Viewer attribution when known.
_Avoid_: Pending request when referring to all accepted requests

## Keyboard raffle

**Keyboard Raffle**:
A Channel Point Redemption giving a Viewer one Roll whose number must exactly match its own Winning Number.
_Avoid_: Lottery, shared stream-wide draw

**Roll**:
One Keyboard Raffle attempt, containing the Viewer's number, Winning Number, Distance, and whether it won.
_Avoid_: Ticket, entry

**Winning Number**:
The target generated separately for a particular Roll.
_Avoid_: Jackpot number

**Distance**:
The absolute difference between a Roll's Viewer number and Winning Number. Zero, and only zero, means a win.
_Avoid_: Score

**Raffle Leaderboard**:
Viewer rankings by participation, wins, or closest rolls. Being closest does not make a non-winning Roll a win.
_Avoid_: Winners when referring to closest non-winning rolls

## Streams and achievements

**Stream Session**:
One period between a stream going online and offline, establishing the boundary for session-scoped achievements and streaks.
_Avoid_: Broadcast when its session boundary matters

**Stream Lifecycle State**:
The integration's evidence of the active or most recent Stream Session, its source start/end times, and peak viewer count.
_Avoid_: Stream status when ordering evidence matters

**Achievement**:
A named milestone a Viewer can unlock through song requests, raffle results, or Stream Session activity.
_Avoid_: Badge except for presentation

**Achievement Definition**:
An Achievement's identity, name, trigger, threshold, category, and cumulative or session scope.
_Avoid_: Rule when referring only to milestone metadata

**Achievement Rule**:
The interpretation of domain evidence that determines progress, unlocks, streak changes, and session resets.
_Avoid_: Definition when referring to behavior

**Achievement Progress**:
A Viewer's cumulative or session-scoped progress toward a particular Achievement.
_Avoid_: Points, XP

**Request Streak**:
The count of consecutive successful Song Requests by a Viewer within a Stream Session.
_Avoid_: Song streak

**Stream Opener**:
The Viewer making the first successful Song Request strictly after the accepted Stream Session start.
_Avoid_: First chatter, first redemption regardless of outcome
