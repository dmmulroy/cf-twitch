import { Result, TaggedError } from "better-result";
import { z } from "zod";

const rfc3339Timestamp = z
	.string()
	.refine(
		(value) =>
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
			!Number.isNaN(Date.parse(value)),
		{ message: "Expected an RFC3339 timestamp" },
	);

const EventSubSubscriptionSchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	version: z.string().min(1),
	status: z.string().min(1),
	cost: z.number().int().nonnegative(),
	condition: z.record(z.string(), z.unknown()),
	transport: z.object({
		method: z.literal("webhook"),
		callback: z.string().url().optional(),
	}),
	created_at: rfc3339Timestamp,
});

const EventSubChallengeBodySchema = z.object({
	subscription: EventSubSubscriptionSchema,
	challenge: z.string().min(1),
});

const EventSubRevocationBodySchema = z.object({
	subscription: EventSubSubscriptionSchema,
});

const EventSubNotificationBodySchema = z.object({
	subscription: EventSubSubscriptionSchema,
	event: z.record(z.string(), z.unknown()),
});

const StreamOnlineEventSchema = z.object({
	id: z.string().min(1),
	broadcaster_user_id: z.string().min(1),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	type: z.string().min(1),
	started_at: rfc3339Timestamp,
});

const StreamOfflineEventSchema = z.object({
	broadcaster_user_id: z.string().min(1),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
});

const RedemptionEventSchema = z.object({
	id: z.string().min(1),
	user_id: z.string().min(1),
	user_login: z.string(),
	user_name: z.string(),
	broadcaster_user_id: z.string().min(1),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	reward: z.object({
		id: z.string().min(1),
		title: z.string(),
		cost: z.number().nonnegative(),
		prompt: z.string(),
	}),
	user_input: z.string(),
	status: z.string().min(1),
	redeemed_at: rfc3339Timestamp,
});

const ChatBadgeSchema = z.object({
	set_id: z.string(),
	id: z.string(),
	info: z.string(),
});

const ChatMessageEventSchema = z.object({
	broadcaster_user_id: z.string().min(1),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	chatter_user_id: z.string().min(1),
	chatter_user_login: z.string(),
	chatter_user_name: z.string(),
	message_id: z.string().min(1),
	message: z.object({
		text: z.string(),
		fragments: z.array(z.unknown()),
	}),
	badges: z.array(ChatBadgeSchema),
});

const RaidEventSchema = z.object({
	from_broadcaster_user_id: z.string().min(1),
	from_broadcaster_user_login: z.string(),
	from_broadcaster_user_name: z.string(),
	to_broadcaster_user_id: z.string().min(1),
	to_broadcaster_user_login: z.string(),
	to_broadcaster_user_name: z.string(),
	viewers: z.number().int().nonnegative(),
});

/** Parsed and mutually consistent Twitch EventSub request headers. */
export const EventSubHeadersSchema = z.object({
	"twitch-eventsub-message-id": z.string().min(1),
	"twitch-eventsub-message-retry": z.string().regex(/^\d+$/),
	"twitch-eventsub-message-type": z.enum([
		"webhook_callback_verification",
		"notification",
		"revocation",
	]),
	"twitch-eventsub-message-signature": z.string().regex(/^sha256=[0-9a-f]{64}$/),
	"twitch-eventsub-message-timestamp": rfc3339Timestamp,
	"twitch-eventsub-subscription-type": z.string().min(1),
	"twitch-eventsub-subscription-version": z.string().min(1),
});

/** Parsed EventSub headers used for authentication, ordering, and dispatch. */
export type EventSubHeaders = z.infer<typeof EventSubHeadersSchema>;

/** A fully parsed EventSub message safe to persist before processing. */
export type ParsedEventSubMessage =
	| {
			readonly _tag: "EventSubChallenge";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly challenge: string;
	  }
	| {
			readonly _tag: "EventSubRevocation";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
	  }
	| {
			readonly _tag: "StreamOnlineNotification";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly event: z.infer<typeof StreamOnlineEventSchema>;
	  }
	| {
			readonly _tag: "StreamOfflineNotification";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly event: z.infer<typeof StreamOfflineEventSchema>;
	  }
	| {
			readonly _tag: "RewardRedemptionNotification";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly event: z.infer<typeof RedemptionEventSchema>;
	  }
	| {
			readonly _tag: "RaidNotification";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly event: z.infer<typeof RaidEventSchema>;
	  }
	| {
			readonly _tag: "ChatMessageNotification";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly event: z.infer<typeof ChatMessageEventSchema>;
	  }
	| {
			readonly _tag: "UnhandledEventSubNotification";
			readonly subscription: z.infer<typeof EventSubSubscriptionSchema>;
			readonly event: Readonly<Record<string, unknown>>;
	  };

/** Expected error when a signed EventSub body violates its message-specific contract. */
export class EventSubMessageParseError extends TaggedError("EventSubMessageParseError")<{
	message: string;
	parseError: string;
}>() {
	constructor(parseError: string) {
		super({
			message: `EventSub message parse failed: ${parseError}`,
			parseError,
		});
	}
}

function parseSchema<T>(
	schema: z.ZodType<T>,
	input: unknown,
): Result<T, EventSubMessageParseError> {
	const parsed = schema.safeParse(input);
	return parsed.success
		? Result.ok(parsed.data)
		: Result.err(new EventSubMessageParseError(parsed.error.message));
}

function requireMatchingSubscription(
	headers: EventSubHeaders,
	subscription: z.infer<typeof EventSubSubscriptionSchema>,
): Result<void, EventSubMessageParseError> {
	if (
		subscription.type !== headers["twitch-eventsub-subscription-type"] ||
		subscription.version !== headers["twitch-eventsub-subscription-version"]
	) {
		return Result.err(
			new EventSubMessageParseError(
				"Signed EventSub subscription type/version does not match the body subscription",
			),
		);
	}
	return Result.ok();
}

/** Parse a signed JSON value into its complete message-specific EventSub contract. */
export function parseEventSubMessage(
	headers: EventSubHeaders,
	body: unknown,
): Result<ParsedEventSubMessage, EventSubMessageParseError> {
	const messageType = headers["twitch-eventsub-message-type"];
	if (messageType === "webhook_callback_verification") {
		const parsed = parseSchema(EventSubChallengeBodySchema, body);
		if (parsed.status === "error") return parsed;
		const matching = requireMatchingSubscription(headers, parsed.value.subscription);
		if (matching.status === "error") return matching;
		return Result.ok({
			_tag: "EventSubChallenge",
			subscription: parsed.value.subscription,
			challenge: parsed.value.challenge,
		});
	}

	if (messageType === "revocation") {
		const parsed = parseSchema(EventSubRevocationBodySchema, body);
		if (parsed.status === "error") return parsed;
		const matching = requireMatchingSubscription(headers, parsed.value.subscription);
		if (matching.status === "error") return matching;
		return Result.ok({ _tag: "EventSubRevocation", subscription: parsed.value.subscription });
	}

	const parsed = parseSchema(EventSubNotificationBodySchema, body);
	if (parsed.status === "error") return parsed;
	const matching = requireMatchingSubscription(headers, parsed.value.subscription);
	if (matching.status === "error") return matching;

	const { subscription, event } = parsed.value;
	switch (subscription.type) {
		case "stream.online": {
			const eventResult = parseSchema(StreamOnlineEventSchema, event);
			return eventResult.status === "error"
				? eventResult
				: Result.ok({ _tag: "StreamOnlineNotification", subscription, event: eventResult.value });
		}
		case "stream.offline": {
			const eventResult = parseSchema(StreamOfflineEventSchema, event);
			return eventResult.status === "error"
				? eventResult
				: Result.ok({ _tag: "StreamOfflineNotification", subscription, event: eventResult.value });
		}
		case "channel.channel_points_custom_reward_redemption.add": {
			const eventResult = parseSchema(RedemptionEventSchema, event);
			return eventResult.status === "error"
				? eventResult
				: Result.ok({
						_tag: "RewardRedemptionNotification",
						subscription,
						event: eventResult.value,
					});
		}
		case "channel.raid": {
			const eventResult = parseSchema(RaidEventSchema, event);
			return eventResult.status === "error"
				? eventResult
				: Result.ok({ _tag: "RaidNotification", subscription, event: eventResult.value });
		}
		case "channel.chat.message": {
			const eventResult = parseSchema(ChatMessageEventSchema, event);
			return eventResult.status === "error"
				? eventResult
				: Result.ok({
						_tag: "ChatMessageNotification",
						subscription,
						event: eventResult.value,
					});
		}
		default:
			return Result.ok({ _tag: "UnhandledEventSubNotification", subscription, event });
	}
}
