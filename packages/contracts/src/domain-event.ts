import { Effect, Schema } from "effect";
import {
  EventId,
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  StreamId,
  ViewerId,
} from "./identity.ts";
import { RaffleDistance, RaffleNumber } from "./raffle.ts";

const domainEventFields = {
  id: EventId,
  v: Schema.Literal(1),
  timestamp: IsoTimestamp,
  correlationId: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
};

/** Song request accepted and fulfilled; event identity remains stable across retries. */
export const SongRequestSuccessEvent = Schema.Struct({
  ...domainEventFields,
  type: Schema.Literal("song_request_success"),
  source: Schema.Literal("SongRequestSagaDO"),
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  sagaId: RedemptionId,
  trackId: SpotifyTrackId,
});
/** Fulfilled song request evidence used by achievement rules. */
export type SongRequestSuccessEvent = typeof SongRequestSuccessEvent.Type;

/** One keyboard raffle outcome; distance and winner status agree with the two numbers. */
export const RaffleRollEvent = Schema.Struct({
  ...domainEventFields,
  type: Schema.Literal("raffle_roll"),
  source: Schema.Literal("KeyboardRaffleSagaDO"),
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  sagaId: RedemptionId,
  roll: RaffleNumber,
  winningNumber: RaffleNumber,
  distance: RaffleDistance,
  isWinner: Schema.Boolean,
  isNewRecord: Schema.Boolean,
})
  .check(
    Schema.makeFilter((event) => event.distance === Math.abs(event.roll - event.winningNumber), {
      message: "Raffle distance must equal the absolute difference between the two numbers",
    }),
    Schema.makeFilter((event) => event.isWinner === (event.distance === 0), {
      message: "Raffle winner status must equal whether the distance is zero",
    }),
    Schema.makeFilter((event) => !(event.isWinner && event.isNewRecord), {
      message: "A winning raffle roll cannot be a closest non-winning record",
    }),
  )
  .pipe(Schema.brand("RaffleRollEvent"));
/** Valid keyboard raffle evidence used by achievement rules. */
export type RaffleRollEvent = typeof RaffleRollEvent.Type;

/** Authoritative start of a stream session, with source time rather than ingestion time. */
export const StreamOnlineEvent = Schema.Struct({
  ...domainEventFields,
  type: Schema.Literal("stream_online"),
  source: Schema.Literal("StreamLifecycleDO"),
  streamId: StreamId,
  startedAt: IsoTimestamp,
});
/** Stream session start evidence. */
export type StreamOnlineEvent = typeof StreamOnlineEvent.Type;

/** Authoritative end of a stream session, retaining the corresponding stream identity. */
export const StreamOfflineEvent = Schema.Struct({
  ...domainEventFields,
  type: Schema.Literal("stream_offline"),
  source: Schema.Literal("StreamLifecycleDO"),
  streamId: StreamId,
  endedAt: IsoTimestamp,
});
/** Stream session end evidence. */
export type StreamOfflineEvent = typeof StreamOfflineEvent.Type;

/** Closed set of durable domain events; new variants require explicit consumer policy. */
export const DomainEvent = Schema.Union([
  SongRequestSuccessEvent,
  RaffleRollEvent,
  StreamOnlineEvent,
  StreamOfflineEvent,
]);
/** Parsed durable domain event with optional correlation normalized to Effect Option. */
export type DomainEvent = typeof DomainEvent.Type;

const DomainEventJson = Schema.fromJsonString(DomainEvent);
const decodeDomainEventJson = Schema.decodeEffect(DomainEventJson);
const encodeDomainEventToJson = Schema.encodeEffect(DomainEventJson);

/** Decode persisted domain event JSON without an unchecked JSON.parse cast. */
export const parseDomainEventJson = (
  input: string,
): Effect.Effect<DomainEvent, Schema.SchemaError> => decodeDomainEventJson(input);

/** Encode a parsed domain event into its stable persisted JSON representation. */
export const encodeDomainEventJson = (
  event: DomainEvent,
): Effect.Effect<string, Schema.SchemaError> => encodeDomainEventToJson(event);
