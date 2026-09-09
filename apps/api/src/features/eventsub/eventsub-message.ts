import { Effect, Predicate, Schema } from "effect";
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
    callback: Schema.optionalKey(
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

/** Parsed EventSub messages retain transport fields only until the dispatch adapter translates them. */
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

/** Closed parsed notification variants with explicit unknown subscription policy. */
export type ParsedEventSubMessage = typeof ParsedEventSubMessage.Type;

const parseMessage = Schema.decodeEffect(Schema.toCodecJson(ParsedEventSubMessage));

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

/** Parse signed EventSub content and reject header/body subscription type or version disagreement. */
export const parseEventSubMessage: (
  headers: EventSubHeaders,
  body: Schema.Json,
) => Effect.Effect<ParsedEventSubMessage, EventSubReceiptError> = Effect.fn(
  "EventSub.parseMessage",
)(
  function* (headers: EventSubHeaders, body: Schema.Json) {
    if (!isEventSubJsonObject(body))
      return yield* new EventSubReceiptError({
        operation: "parse-message",
        reason: "invalid",
      });

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
    );

    if (
      message.subscription.type !== headers["twitch-eventsub-subscription-type"] ||
      message.subscription.version !== headers["twitch-eventsub-subscription-version"]
    ) {
      return yield* Effect.fail(
        new EventSubReceiptError({
          operation: "parse-message",
          reason: "invalid",
        }),
      );
    }

    return message;
  },
  Effect.mapError(
    () =>
      new EventSubReceiptError({
        operation: "parse-message",
        reason: "invalid",
      }),
  ),
);
