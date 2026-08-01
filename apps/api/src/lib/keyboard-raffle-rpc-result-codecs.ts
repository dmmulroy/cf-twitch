import { Result } from "better-result";
import { z } from "zod";

import {
	KeyboardRaffleRollSchema,
	RaffleLeaderboardEntrySchema,
	RaffleLeaderboardSchema,
} from "../domain/keyboard-raffle";
import {
	KeyboardRaffleDataParseError,
	KeyboardRaffleDbError,
	KeyboardRaffleInputParseError,
	RollIdempotencyConflictError,
	UserStatsNotFoundError,
} from "./errors";

type KeyboardRaffleError =
	| KeyboardRaffleDataParseError
	| KeyboardRaffleDbError
	| KeyboardRaffleInputParseError
	| RollIdempotencyConflictError
	| UserStatsNotFoundError;
const KeyboardRaffleWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("KeyboardRaffleDataParseError"),
		operation: z.string(),
		issues: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("KeyboardRaffleDbError"),
		operation: z.string(),
		cause: z.unknown().optional(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("KeyboardRaffleInputParseError"),
		operation: z.string(),
		issues: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("RollIdempotencyConflictError"),
		rollId: z.string(),
		message: z.string(),
	}),
	z.object({ _tag: z.literal("UserStatsNotFoundError"), userId: z.string(), message: z.string() }),
]);
type KeyboardRaffleWireError = z.infer<typeof KeyboardRaffleWireErrorSchema>;
const KeyboardRaffleErrorToWireSchema = z
	.custom<KeyboardRaffleError>(
		(value) => typeof value === "object" && value !== null && "_tag" in value,
	)
	.transform((error): KeyboardRaffleWireError => ({ ...error, message: error.message }))
	.pipe(KeyboardRaffleWireErrorSchema);
const KeyboardRaffleErrorFromWireSchema = KeyboardRaffleWireErrorSchema.transform(
	(error): KeyboardRaffleError => {
		switch (error._tag) {
			case "KeyboardRaffleDataParseError":
				return new KeyboardRaffleDataParseError({
					operation: error.operation,
					issues: error.issues,
				});
			case "KeyboardRaffleDbError":
				return new KeyboardRaffleDbError({ operation: error.operation, cause: error.cause });
			case "KeyboardRaffleInputParseError":
				return new KeyboardRaffleInputParseError({
					operation: error.operation,
					issues: error.issues,
				});
			case "RollIdempotencyConflictError":
				return new RollIdempotencyConflictError({ rollId: error.rollId });
			case "UserStatsNotFoundError":
				return new UserStatsNotFoundError({ userId: error.userId });
		}
	},
);
function createKeyboardRaffleResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: { ok: okSchema, err: KeyboardRaffleErrorToWireSchema },
		deserialize: { ok: okSchema, err: KeyboardRaffleErrorFromWireSchema },
	});
}

/** RPC codec for recording one Keyboard Raffle Roll. */
export const RecordKeyboardRaffleRollResultCodec = createKeyboardRaffleResultCodec(
	z.object({ roll: KeyboardRaffleRollSchema, isNewRecord: z.boolean() }),
);
/** RPC codec for deleting one Keyboard Raffle Roll. */
export const DeleteKeyboardRaffleRollResultCodec = createKeyboardRaffleResultCodec(z.undefined());
/** RPC codec for reading the Keyboard Raffle leaderboard. */
export const GetKeyboardRaffleLeaderboardResultCodec =
	createKeyboardRaffleResultCodec(RaffleLeaderboardSchema);
/** RPC codec for reading one Viewer's Keyboard Raffle statistics. */
export const GetKeyboardRaffleViewerStatsResultCodec = createKeyboardRaffleResultCodec(
	RaffleLeaderboardEntrySchema,
);
/** RPC codec for reading one Viewer by historical display name. */
export const GetKeyboardRaffleDisplayNameStatsResultCodec = createKeyboardRaffleResultCodec(
	RaffleLeaderboardEntrySchema,
);
/** RPC codec for reading the closest non-winning Keyboard Raffle Roll. */
export const GetClosestKeyboardRaffleRecordResultCodec = createKeyboardRaffleResultCodec(
	z
		.object({
			userId: z.string(),
			displayName: z.string(),
			distance: z.number().int().nonnegative(),
		})
		.nullable(),
);
