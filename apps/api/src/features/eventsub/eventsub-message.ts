import { Effect, Option, Predicate, Schema } from "effect";
import { EventSubHeaders, EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import {
  BroadcasterId,
  EventSubMessageId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  RewardId,
  ViewerId,
} from "@cf-twitch/contracts/identity";

const EventSubSubscription = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  cost: NonNegativeInt,
  condition: Schema.Record(Schema.String, Schema.Json),
  transport: Schema.Struct({
    method: Schema.Literal("webhook"),
    callback: Schema.OptionFromOptionalKey(
      Schema.String.check(
        Schema.makeFilter((value) => URL.canParse(value), {
          message: "EventSub callback must be an absolute URL",
        }),
      ),
    ),
  }),
  created_at: IsoTimestamp,
});

const broadcasterFields = {
  broadcaster_user_id: BroadcasterId,
  broadcaster_user_login: Schema.String,
  broadcaster_user_name: Schema.String,
};

const StreamOnlineEvent = Schema.Struct({
  ...broadcasterFields,
  id: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  started_at: IsoTimestamp,
});

const StreamOfflineEvent = Schema.Struct(broadcasterFields);

const RedemptionEvent = Schema.Struct({
  ...broadcasterFields,
  id: RedemptionId,
  user_id: ViewerId,
  user_login: Schema.String,
  user_name: Schema.String,
  reward: Schema.Struct({
    id: RewardId,
    title: Schema.String,
    cost: NonNegativeInt,
    prompt: Schema.String,
  }),
  user_input: Schema.String,
  status: Schema.NonEmptyString,
  redeemed_at: IsoTimestamp,
});

const RaidEvent = Schema.Struct({
  from_broadcaster_user_id: BroadcasterId,
  from_broadcaster_user_login: Schema.String,
  from_broadcaster_user_name: Schema.String,
  to_broadcaster_user_id: BroadcasterId,
  to_broadcaster_user_login: Schema.String,
  to_broadcaster_user_name: Schema.String,
  viewers: NonNegativeInt,
});

const ChatMessageEvent = Schema.Struct({
  ...broadcasterFields,
  chatter_user_id: ViewerId,
  chatter_user_login: Schema.String,
  chatter_user_name: Schema.String,
  message_id: EventSubMessageId,
  message: Schema.Struct({ text: Schema.String, fragments: Schema.Array(Schema.Json) }),
  badges: Schema.Array(
    Schema.Struct({ set_id: Schema.String, id: Schema.String, info: Schema.String }),
  ),
});

/** Schema for signed EventSub messages, retaining transport fields only until the dispatch adapter translates them. */
export const ParsedEventSubMessage = Schema.TaggedUnion({
  EventSubChallenge: { subscription: EventSubSubscription, challenge: Schema.NonEmptyString },
  EventSubRevocation: { subscription: EventSubSubscription },
  StreamOnlineNotification: { subscription: EventSubSubscription, event: StreamOnlineEvent },
  StreamOfflineNotification: { subscription: EventSubSubscription, event: StreamOfflineEvent },
  RewardRedemptionNotification: { subscription: EventSubSubscription, event: RedemptionEvent },
  RaidNotification: { subscription: EventSubSubscription, event: RaidEvent },
  ChatMessageNotification: { subscription: EventSubSubscription, event: ChatMessageEvent },
  UnhandledEventSubNotification: {
    subscription: EventSubSubscription,
    event: Schema.Record(Schema.String, Schema.Json),
  },
});

/** Parsed EventSub message: a closed set of notification variants with an explicit unhandled-subscription variant. */
export type ParsedEventSubMessage = typeof ParsedEventSubMessage.Type;

// The JSON body's shape is untrusted until this decode, so the decoder accepts unknown input.
const parseMessage = Schema.decodeUnknownEffect(Schema.toCodecJson(ParsedEventSubMessage));

const isEventSubJsonObject = (body: Schema.Json): body is Schema.JsonObject =>
  Predicate.isReadonlyObject(body);

const selectEventSubMessageTag = (
  messageType: EventSubHeaders["twitch-eventsub-message-type"],
  subscriptionType: EventSubHeaders["twitch-eventsub-subscription-type"],
): ParsedEventSubMessage["_tag"] => {
  if (messageType === "webhook_callback_verification") return "EventSubChallenge";

  if (messageType === "revocation") return "EventSubRevocation";

  if (subscriptionType === "stream.online") return "StreamOnlineNotification";

  if (subscriptionType === "stream.offline") return "StreamOfflineNotification";

  if (subscriptionType === "channel.channel_points_custom_reward_redemption.add")
    return "RewardRedemptionNotification";

  if (subscriptionType === "channel.raid") return "RaidNotification";

  if (subscriptionType === "channel.chat.message") return "ChatMessageNotification";

  return "UnhandledEventSubNotification";
};

/**
 * Parses signed EventSub content into a closed message variant selected by the signed headers.
 *
 * **Details**
 *
 * The message type and subscription type headers select the variant, overriding any `_tag` in the body.
 *
 * @param headers - Authenticated EventSub transport headers.
 * @param body - JSON body whose bytes were authenticated with `headers`.
 * @returns The parsed message, or fails with `EventSubReceiptError` reason `invalid` when the body is not an object, does not match its variant, or disagrees with the header subscription type or version.
 */
export const parseEventSubMessage = Effect.fn("EventSub.parseMessage")(function* (
  headers: EventSubHeaders,
  body: Schema.Json,
) {
  const invalid = () =>
    new EventSubReceiptError({
      operation: "parse-message",
      reason: "invalid",
      messageId: Option.some(headers["twitch-eventsub-message-id"]),
    });

  if (!isEventSubJsonObject(body)) return yield* invalid();

  // Own-entry reconstruction avoids Object.assign's __proto__ setter while the final entry overrides a body-supplied tag.
  const message = yield* parseMessage(
    Object.fromEntries([
      ...Object.entries(body),
      [
        "_tag",
        selectEventSubMessageTag(
          headers["twitch-eventsub-message-type"],
          headers["twitch-eventsub-subscription-type"],
        ),
      ],
    ]),
  ).pipe(Effect.catchTag("SchemaError", () => Effect.fail(invalid())));

  if (
    message.subscription.type !== headers["twitch-eventsub-subscription-type"] ||
    message.subscription.version !== headers["twitch-eventsub-subscription-version"]
  )
    return yield* invalid();

  return message;
});
