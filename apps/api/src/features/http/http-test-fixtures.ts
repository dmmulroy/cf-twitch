import { Redacted, Schema } from "effect";
import { BroadcasterId, RewardId } from "@cf-twitch/contracts/identity";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";

/** Synthetic HTTP test configuration contains no real credentials or production resource identities. */
export const httpTestConfiguration = TwitchConfiguration.of({
  twitch: {
    clientId: "twitch-client",
    clientSecret: Redacted.make("twitch-secret"),
    broadcaster: { id: Schema.decodeSync(BroadcasterId)("12345"), displayName: "Dillon" },
  },
  spotify: { clientId: "spotify-client", clientSecret: Redacted.make("spotify-secret") },
  eventSubSecret: Redacted.make("webhook-secret"),
  oauthSetupSecret: Redacted.make("setup-secret"),
  administratorSecret: Redacted.make("admin-secret"),
  rewardRouting: {
    songRequestRewardId: Schema.decodeSync(RewardId)("song-reward"),
    keyboardRaffleRewardId: Schema.decodeSync(RewardId)("raffle-reward"),
  },
});
