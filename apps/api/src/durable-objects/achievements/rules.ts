import { EventType, type Event } from "../schemas/event-bus-do.schema";

export type TriggerEvent =
	| "song_request"
	| "stream_first_request"
	| "raffle_roll"
	| "raffle_win"
	| "raffle_close"
	| "raffle_closest_record"
	| "request_streak";

export type AchievementCategory = "song_request" | "raffle" | "engagement" | "special";
export type AchievementScope = "session" | "cumulative";

export type AchievementRuleDefinition = {
	id: string;
	name: string;
	description: string;
	icon: string;
	category: AchievementCategory;
	threshold: number | null;
	triggerEvent: TriggerEvent;
	scope: AchievementScope;
};

export type AchievementProgressFact = {
	achievementId: string;
	progress: number;
	unlockedAt: string | null;
	eventId: string | null;
};

export type RequestStreakFact = {
	userId: string;
	userDisplayName: string;
	sessionStreak: number;
	longestStreak: number;
	lastRequestAt: string | null;
};

export type AchievementFacts = {
	definitions: AchievementRuleDefinition[];
	viewer?: {
		userId: string;
		userDisplayName: string;
		progressByAchievementId: Map<string, AchievementProgressFact>;
		requestStreak?: RequestStreakFact;
	};
	streamSession: {
		isLive: boolean;
		currentStreamStartedAt: string | null;
		isStreamOpenerCandidate: boolean;
	};
};

export type AchievementRuleInput = {
	event: Event;
	facts: AchievementFacts;
	now: string;
};

export type UpsertAchievementProgress = {
	kind: "upsert-achievement-progress";
	userDisplayName: string;
	achievementId: string;
	progress: number;
	unlockedAt: string | null;
	eventId: string | null;
	newlyUnlocked: boolean;
};

export type QueueAchievementUnlockEffect = {
	kind: "queue-achievement-unlock-effect";
	userDisplayName: string;
	achievement: {
		id: string;
		name: string;
		description: string;
		category: AchievementCategory;
	};
};

export type UpdateRequestStreak = {
	kind: "update-request-streak";
	userId: string;
	userDisplayName: string;
	sessionStreak: number;
	longestStreak: number;
	lastRequestAt: string;
};

export type ResetSessionAchievementProgress = {
	kind: "reset-session-achievement-progress";
	achievementIds: string[];
};

export type ResetAllRequestStreaks = {
	kind: "reset-all-request-streaks";
	sessionStartedAt: string;
};

export type SetStreamSessionState = {
	kind: "set-stream-session-state";
	isLive: boolean;
	currentStreamStartedAt: string | null;
};

export type AchievementRuleDecision =
	| UpsertAchievementProgress
	| ResetSessionAchievementProgress
	| UpdateRequestStreak
	| ResetAllRequestStreaks
	| SetStreamSessionState
	| QueueAchievementUnlockEffect;

export function evaluateAchievementRules(input: AchievementRuleInput): AchievementRuleDecision[] {
	switch (input.event.type) {
		case EventType.SongRequestSuccess:
			return evaluateSongRequestRules(input);
		case EventType.RaffleRoll:
			return evaluateRaffleRules(input);
		case EventType.StreamOnline:
			return evaluateStreamOnlineRules(input);
		case EventType.StreamOffline:
			return [
				{
					kind: "set-stream-session-state",
					isLive: false,
					currentStreamStartedAt: null,
				},
			];
	}
}

function evaluateSongRequestRules(input: AchievementRuleInput): AchievementRuleDecision[] {
	const viewer = input.facts.viewer;
	if (viewer === undefined) {
		return [];
	}

	const decisions: AchievementRuleDecision[] = [];
	decisions.push(...progressForTrigger("song_request", input));

	if (input.facts.streamSession.isStreamOpenerCandidate) {
		decisions.push(...progressForTrigger("stream_first_request", input));
	}

	const nextStreak = calculateNextRequestStreak(viewer, input.now);
	decisions.push({
		kind: "update-request-streak",
		...nextStreak,
	});

	if (nextStreak.sessionStreak >= 3) {
		decisions.push(
			...progressForTrigger("request_streak", input, {
				mode: "set",
				value: nextStreak.sessionStreak,
			}),
		);
	}

	return decisions;
}

function evaluateRaffleRules(input: AchievementRuleInput): AchievementRuleDecision[] {
	const event = input.event;
	if (event.type !== EventType.RaffleRoll) {
		return [];
	}

	const decisions: AchievementRuleDecision[] = [];
	decisions.push(...progressForTrigger("raffle_roll", input));

	if (event.isWinner) {
		decisions.push(...progressForTrigger("raffle_win", input));
	}

	if (!event.isWinner && event.distance <= 100) {
		decisions.push(...progressForTrigger("raffle_close", input));
	}

	if (!event.isWinner && event.isNewRecord) {
		decisions.push(...progressForTrigger("raffle_closest_record", input));
	}

	return decisions;
}

function evaluateStreamOnlineRules(input: AchievementRuleInput): AchievementRuleDecision[] {
	return [
		{
			kind: "set-stream-session-state",
			isLive: true,
			currentStreamStartedAt: input.now,
		},
		{
			kind: "reset-session-achievement-progress",
			achievementIds: input.facts.definitions
				.filter((definition) => definition.scope === "session")
				.map((definition) => definition.id),
		},
		{
			kind: "reset-all-request-streaks",
			sessionStartedAt: input.now,
		},
	];
}

function progressForTrigger(
	triggerEvent: TriggerEvent,
	input: AchievementRuleInput,
	mode: { mode: "increment"; value: number } | { mode: "set"; value: number } = {
		mode: "increment",
		value: 1,
	},
): AchievementRuleDecision[] {
	const viewer = input.facts.viewer;
	if (viewer === undefined) {
		return [];
	}

	const decisions: AchievementRuleDecision[] = [];
	const definitions = input.facts.definitions.filter(
		(definition) => definition.triggerEvent === triggerEvent,
	);

	for (const definition of definitions) {
		const existing = viewer.progressByAchievementId.get(definition.id);
		if (
			definition.threshold === null &&
			existing?.eventId === eventIdForTrigger(input, triggerEvent)
		) {
			continue;
		}
		if (definition.threshold !== null && existing?.unlockedAt !== null && existing !== undefined) {
			continue;
		}

		const currentProgress = existing?.progress ?? 0;
		const progress = mode.mode === "set" ? mode.value : currentProgress + mode.value;
		const unlocked = shouldUnlock(definition, progress);
		const newlyUnlocked = unlocked && (existing === undefined || existing.unlockedAt === null);
		const unlockedAt = unlocked ? (existing?.unlockedAt ?? input.now) : null;
		const eventId = definition.threshold === null ? eventIdForTrigger(input, triggerEvent) : null;

		decisions.push({
			kind: "upsert-achievement-progress",
			userDisplayName: viewer.userDisplayName,
			achievementId: definition.id,
			progress,
			unlockedAt,
			eventId,
			newlyUnlocked,
		});

		if (newlyUnlocked) {
			decisions.push({
				kind: "queue-achievement-unlock-effect",
				userDisplayName: viewer.userDisplayName,
				achievement: {
					id: definition.id,
					name: definition.name,
					description: definition.description,
					category: definition.category,
				},
			});
		}
	}

	return decisions;
}

function calculateNextRequestStreak(
	viewer: NonNullable<AchievementFacts["viewer"]>,
	now: string,
): Omit<UpdateRequestStreak, "kind"> {
	const currentSessionStreak = viewer.requestStreak?.sessionStreak ?? 0;
	const sessionStreak = currentSessionStreak + 1;
	return {
		userId: viewer.userId,
		userDisplayName: viewer.userDisplayName,
		sessionStreak,
		longestStreak: Math.max(viewer.requestStreak?.longestStreak ?? 0, sessionStreak),
		lastRequestAt: now,
	};
}

function shouldUnlock(definition: AchievementRuleDefinition, progress: number): boolean {
	if (definition.threshold === null) {
		return progress >= 1;
	}

	return progress >= definition.threshold;
}

function eventIdForTrigger(input: AchievementRuleInput, triggerEvent: TriggerEvent): string {
	switch (triggerEvent) {
		case "stream_first_request":
			return `${input.event.id}-first-request`;
		case "request_streak":
			return `${input.event.id}-streak`;
		case "raffle_win":
			return `${input.event.id}-win`;
		case "raffle_close":
			return `${input.event.id}-close`;
		case "raffle_closest_record":
			return `${input.event.id}-closest-record`;
		case "song_request":
		case "raffle_roll":
			return input.event.id;
	}
}
