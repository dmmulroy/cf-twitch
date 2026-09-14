import { Context, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import { AcceptedEventSubReceipt, EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import { ChatCommandName } from "@cf-twitch/contracts/chat-command";
import { ChatMessageText } from "@cf-twitch/contracts/provider";
import { getChatCommandPermission } from "../commands/command-permissions.ts";
import { StreamId } from "@cf-twitch/contracts/identity";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { WorkflowStarters } from "../workflows/workflow-starters.ts";
import { StreamLifecycleClient } from "../stream/stream-lifecycle.ts";
import { ChatCommandExecutor } from "../commands/chat-command-executor.ts";
import { parseEventSubMessage } from "./eventsub-message.ts";

/** Prepared chat response is persisted before delivery; preparation never sends to Twitch. */
export const EventSubChatResponse = Schema.Struct({
  commandName: ChatCommandName,
  message: ChatMessageText,
});

/** Parsed command response ready for durable sending intent. */
export type EventSubChatResponse = typeof EventSubChatResponse.Type;

/** Dispatch owns notification translation while the inbox owns leases and chat sending checkpoints. */
export interface IEventSubDispatch {
  readonly dispatch: (
    receipt: AcceptedEventSubReceipt,
  ) => Effect.Effect<Option.Option<EventSubChatResponse>, EventSubReceiptError>;
}

/** Parsed EventSub dispatcher composes real workflow, stream and command capabilities. */
export class EventSubDispatch extends Context.Service<EventSubDispatch, IEventSubDispatch>()(
  "@cf-twitch/EventSubDispatch",
) {}

/** Construct notification routing with parsed runtime reward configuration. */
export const makeEventSubDispatch = Effect.gen(function* () {
  const configuration = yield* TwitchConfiguration;
  const workflows = yield* WorkflowStarters;
  const stream = yield* StreamLifecycleClient;
  const commands = yield* ChatCommandExecutor;

  const dispatch = Effect.fn("EventSubDispatch.dispatch")(
    function* (receipt: AcceptedEventSubReceipt) {
      const message = yield* parseEventSubMessage(receipt.headers, receipt.body);
      // Signed source time is stable across redelivery; receivedAt is only first server-ingestion metadata.
      const sourceTimestamp = receipt.headers["twitch-eventsub-message-timestamp"];

      return yield* Match.value(message).pipe(
        Match.tagsExhaustive({
          EventSubChallenge: () => Effect.succeed(Option.none<EventSubChatResponse>()),
          EventSubRevocation: (revocation) =>
            Effect.logWarning("EventSub subscription revoked", {
              subscriptionType: revocation.subscription.type,
              status: revocation.subscription.status,
            }).pipe(Effect.as(Option.none<EventSubChatResponse>())),
          UnhandledEventSubNotification: (notification) =>
            Effect.logWarning("EventSub subscription type is unhandled", {
              subscriptionType: notification.subscription.type,
            }).pipe(Effect.as(Option.none<EventSubChatResponse>())),
          StreamOnlineNotification: (notification) =>
            stream
              .markOnline({
                streamId: StreamId.make(notification.event.id),
                startedAt: notification.event.started_at,
              })
              .pipe(Effect.as(Option.none<EventSubChatResponse>())),
          StreamOfflineNotification: () =>
            stream
              .markOffline({ endedAt: sourceTimestamp })
              .pipe(Effect.as(Option.none<EventSubChatResponse>())),
          RaidNotification: (notification) =>
            workflows
              .startRaidShoutout({
                messageId: receipt.messageId,
                receivedAt: sourceTimestamp,
                raider: {
                  userId: notification.event.from_broadcaster_user_id,
                  login: notification.event.from_broadcaster_user_login,
                  displayName: notification.event.from_broadcaster_user_name,
                },
                viewers: notification.event.viewers,
              })
              .pipe(Effect.as(Option.none<EventSubChatResponse>())),
          RewardRedemptionNotification: (notification) =>
            Effect.gen(function* () {
              const event = notification.event;

              const redemption = {
                id: event.id,
                broadcasterId: event.broadcaster_user_id,
                userId: event.user_id,
                userLogin: event.user_login,
                userDisplayName: event.user_name,
                userInput: event.user_input,
                reward: event.reward,
                redeemedAt: event.redeemed_at,
              };

              if (event.reward.id === configuration.rewardRouting.songRequestRewardId)
                yield* workflows.startSongRequest(redemption);
              else if (event.reward.id === configuration.rewardRouting.keyboardRaffleRewardId)
                yield* workflows.startKeyboardRaffle(redemption);

              return Option.none<EventSubChatResponse>();
            }),
          ChatMessageNotification: (notification) =>
            Effect.gen(function* () {
              const event = notification.event;
              const permission = getChatCommandPermission(event.badges);

              const prepared = yield* commands.prepare({
                messageId: event.message_id,
                text: event.message.text.trim(),
                receivedAt: sourceTimestamp,
                viewer: {
                  userId: event.chatter_user_id,
                  displayName: event.chatter_user_name,
                  permission,
                },
              });

              if (
                Predicate.isTagged(prepared, "ChatCommandIgnored") ||
                Option.isNone(prepared.message)
              )
                return Option.none<EventSubChatResponse>();

              const chatMessage = yield* ChatMessageText.makeEffect(prepared.message.value).pipe(
                Effect.mapError(
                  () =>
                    new EventSubReceiptError({
                      operation: "prepare-chat",
                      reason: "invalid",
                    }),
                ),
              );

              return Option.some({ commandName: prepared.commandName, message: chatMessage });
            }),
        }),
      );
    },
    Effect.mapError(
      () =>
        new EventSubReceiptError({
          operation: "dispatch",
          reason: "dispatch",
        }),
    ),
  );

  return EventSubDispatch.of({ dispatch });
});

/** EventSub dispatch retains dependency requirements instead of fake production fallbacks. */
export const eventSubDispatchLayerWithoutDependencies = Layer.effect(
  EventSubDispatch,
  makeEventSubDispatch,
);
