import { Context, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import { AcceptedEventSubReceipt, EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import { ChatCommandName } from "@cf-twitch/contracts/chat-command";
import { ChatMessageText } from "@cf-twitch/contracts/provider";
import { getChatCommandPermission } from "../commands/command-permissions.ts";
import { StreamId } from "@cf-twitch/contracts/identity";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import {
  WorkflowStarters,
  workflowStartersLayer,
  workflowStartersTestLayer,
} from "../workflows/workflow-starters.ts";
import { StreamLifecycleClient } from "../stream/stream-lifecycle.ts";
import { streamLifecycleClientLayer } from "../stream/stream-lifecycle-client.ts";
import { ChatCommandExecutor, executorLayer } from "../commands/chat-command-executor.ts";
import { parseEventSubMessage } from "./eventsub-message.ts";

/** Schema for a prepared Chat Command reply, persisted before delivery; preparation never sends to Twitch. */
export const EventSubChatResponse = Schema.Struct({
  commandName: ChatCommandName,
  message: ChatMessageText,
});

/** Prepared Chat Command reply, ready for a durable sending intent. */
export type EventSubChatResponse = typeof EventSubChatResponse.Type;

/** Notification translation into workflow, stream, and Chat Command effects; the inbox owns leases and chat sending checkpoints. */
export interface IEventSubDispatch {
  /**
   * Applies one accepted notification to its owning capability and returns any Chat Command reply to send.
   *
   * **Details**
   *
   * Configured rewards start Song Request or Keyboard Raffle workflows, raids start the shoutout workflow, stream online/offline update the Stream Session, and chat messages prepare Chat Commands. Revocations and unhandled subscriptions are logged without domain mutation.
   *
   * @returns The prepared reply, `None` when nothing should be sent, or fails with `EventSubReceiptError` reason `dispatch` when parsing, the owning capability, or reply preparation fails; the inbox retries that failure.
   */
  readonly dispatch: (
    receipt: AcceptedEventSubReceipt,
  ) => Effect.Effect<Option.Option<EventSubChatResponse>, EventSubReceiptError>;
}

/** Service tag for EventSub notification dispatch over the workflow, stream, and Chat Command capabilities. */
export class EventSubDispatch extends Context.Service<EventSubDispatch, IEventSubDispatch>()(
  "@cf-twitch/EventSubDispatch",
) {}

/** Effect that builds notification routing with the parsed runtime reward configuration. */
export const makeEventSubDispatch = Effect.gen(function* () {
  const configuration = yield* TwitchConfiguration;
  const workflows = yield* WorkflowStarters;
  const stream = yield* StreamLifecycleClient;
  const commands = yield* ChatCommandExecutor;

  const dispatch = Effect.fn("EventSubDispatch.dispatch")(function* (
    receipt: AcceptedEventSubReceipt,
  ) {
    // The channel has one meaning: any parse, workflow, stream, or Chat Command failure is a retryable dispatch failure.
    const dispatchFailed = () =>
      new EventSubReceiptError({
        operation: "dispatch",
        reason: "dispatch",
        messageId: Option.some(receipt.messageId),
      });

    return yield* Effect.gen(function* () {
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
                      messageId: Option.some(receipt.messageId),
                    }),
                ),
              );

              return Option.some({ commandName: prepared.commandName, message: chatMessage });
            }),
        }),
      );
    }).pipe(Effect.mapError(dispatchFailed));
  });

  return EventSubDispatch.of({ dispatch });
});

/** Layer that provides EventSub dispatch; requires reward configuration, workflow starters, the stream lifecycle client, and the Chat Command executor. */
export const eventSubDispatchLayerWithoutDependencies = Layer.effect(
  EventSubDispatch,
  makeEventSubDispatch,
);

/** Production dispatch Layer over the workflow, stream lifecycle, and Chat Command Durable Object clients; requires reward configuration. */
export const eventSubDispatchLayer = eventSubDispatchLayerWithoutDependencies.pipe(
  Layer.provide([workflowStartersLayer, streamLifecycleClientLayer, executorLayer]),
);

/** Dispatch Layer over in-memory workflow starters; the test selects reward configuration, the stream lifecycle, and the Chat Command executor. */
export const eventSubDispatchTestLayer = eventSubDispatchLayerWithoutDependencies.pipe(
  Layer.provide(workflowStartersTestLayer),
);
