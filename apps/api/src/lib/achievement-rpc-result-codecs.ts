import { Result } from "better-result";
import { z } from "zod";

import {
	AchievementDebugTableCountsSchema,
	AchievementDebugUserSnapshotSchema,
	AchievementDefinitionsSchema,
	AchievementLeaderboardSchema,
	AchievementResetResultSchema,
	UnlockedAchievementSchema,
	UnlockedAchievementsSchema,
	ViewerAchievementProgressListSchema,
} from "../domain/achievement";
import {
	AchievementDbError,
	AchievementEventValidationError,
	AchievementNotFoundError,
	AchievementQueryValidationError,
	InvalidAchievementRecordError,
	type AchievementError,
} from "./errors";

const AchievementWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("AchievementDbError"),
		operation: z.string(),
		cause: z.unknown().optional(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("AchievementNotFoundError"),
		achievementId: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("AchievementEventValidationError"),
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("AchievementQueryValidationError"),
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("InvalidAchievementRecordError"),
		recordType: z.string(),
		parseError: z.string(),
		message: z.string(),
	}),
]);
type AchievementWireError = z.infer<typeof AchievementWireErrorSchema>;
const AchievementErrorToWireSchema = z
	.custom<AchievementError>(
		(value) => typeof value === "object" && value !== null && "_tag" in value,
	)
	.transform((error): AchievementWireError => ({ ...error, message: error.message }))
	.pipe(AchievementWireErrorSchema);
const AchievementErrorFromWireSchema = AchievementWireErrorSchema.transform(
	(error): AchievementError => {
		switch (error._tag) {
			case "AchievementDbError":
				return new AchievementDbError({ operation: error.operation, cause: error.cause });
			case "AchievementNotFoundError":
				return new AchievementNotFoundError({ achievementId: error.achievementId });
			case "AchievementEventValidationError":
				return new AchievementEventValidationError({ parseError: error.parseError });
			case "AchievementQueryValidationError":
				return new AchievementQueryValidationError({ parseError: error.parseError });
			case "InvalidAchievementRecordError":
				return new InvalidAchievementRecordError({
					recordType: error.recordType,
					parseError: error.parseError,
				});
		}
	},
);
function createAchievementResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: { ok: okSchema, err: AchievementErrorToWireSchema },
		deserialize: { ok: okSchema, err: AchievementErrorFromWireSchema },
	});
}
const UnannouncedAchievementListSchema = z.array(
	z.object({ userDisplayName: z.string(), achievement: UnlockedAchievementSchema }),
);

/** RPC codec for recording one Achievement event. */
export const RecordAchievementEventResultCodec = createAchievementResultCodec(
	UnlockedAchievementsSchema,
);
/** RPC codec for reading one Viewer's Achievement progress. */
export const GetViewerAchievementsResultCodec = createAchievementResultCodec(
	ViewerAchievementProgressListSchema,
);
/** RPC codec for reading one Viewer's unlocked Achievements. */
export const GetUnlockedAchievementsResultCodec = createAchievementResultCodec(
	UnlockedAchievementsSchema,
);
/** RPC codec for reading all Achievement definitions. */
export const GetAchievementDefinitionsResultCodec = createAchievementResultCodec(
	AchievementDefinitionsSchema,
);
/** RPC codec for reading Achievement table counts. */
export const GetAchievementTableCountsResultCodec = createAchievementResultCodec(
	AchievementDebugTableCountsSchema,
);
/** RPC codec for reading one Viewer's Achievement debug snapshot. */
export const GetAchievementUserSnapshotResultCodec = createAchievementResultCodec(
	AchievementDebugUserSnapshotSchema,
);
/** RPC codec for reading unannounced Achievement unlocks. */
export const GetUnannouncedAchievementsResultCodec = createAchievementResultCodec(
	UnannouncedAchievementListSchema,
);
/** RPC codec for reading the Achievement leaderboard. */
export const GetAchievementLeaderboardResultCodec = createAchievementResultCodec(
	AchievementLeaderboardSchema,
);
/** RPC codec for resetting one-time Achievements. */
export const ResetOneTimeAchievementsResultCodec = createAchievementResultCodec(
	AchievementResetResultSchema,
);
/** RPC codec for accepting an online Achievement Stream Lifecycle transition. */
export const AchievementStreamOnlineResultCodec = createAchievementResultCodec(z.undefined());
/** RPC codec for accepting an offline Achievement Stream Lifecycle transition. */
export const AchievementStreamOfflineResultCodec = createAchievementResultCodec(z.undefined());
/** RPC codec for applying one Domain Event to Achievement state. */
export const HandleAchievementEventResultCodec = createAchievementResultCodec(z.undefined());
