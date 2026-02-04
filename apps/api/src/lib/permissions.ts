/**
 * Permission utilities for chat commands
 *
 * Maps Twitch EventSub chat badges to permission levels.
 */

/**
 * Permission levels for chat commands (highest to lowest).
 */
export type Permission = "broadcaster" | "moderator" | "everyone";

/**
 * Twitch EventSub chat badge format.
 * Only `set_id` is needed for permission checks.
 */
export interface Badge {
	set_id: string;
	id: string;
	info: string;
}

/**
 * Derives the highest permission level from a user's badges.
 *
 * @param badges - Array of Twitch chat badges
 * @returns The highest permission level: broadcaster > moderator > everyone
 */
export function getUserPermission(badges: Badge[]): Permission {
	if (badges.some((b) => b.set_id === "broadcaster")) return "broadcaster";
	if (badges.some((b) => b.set_id === "moderator")) return "moderator";
	return "everyone";
}

/**
 * Checks if a user's permission meets or exceeds the required level.
 *
 * @param userPermission - The user's derived permission
 * @param required - The minimum required permission
 * @returns true if user has sufficient permission
 */
export function hasPermission(userPermission: Permission, required: Permission): boolean {
	const levels: Record<Permission, number> = {
		broadcaster: 2,
		moderator: 1,
		everyone: 0,
	};
	return levels[userPermission] >= levels[required];
}
