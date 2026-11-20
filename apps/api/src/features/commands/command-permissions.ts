import type { ChatCommandPermission } from "@cf-twitch/contracts/chat-command";

const commandPermissionRanks = { everyone: 0, vip: 1, moderator: 2, broadcaster: 3 };

/** Returns whether a viewer's permission meets a required tier in the broadcaster > moderator > VIP > everyone hierarchy. */
export function hasCommandPermission(
  actual: ChatCommandPermission,
  required: ChatCommandPermission,
): boolean {
  return commandPermissionRanks[actual] >= commandPermissionRanks[required];
}

/** Returns the highest command permission granted by verified Twitch chat badges; subscriber badges grant none. */
export function getChatCommandPermission(
  badges: readonly { readonly set_id: string }[],
): ChatCommandPermission {
  if (badges.some((badge) => badge.set_id === "broadcaster")) return "broadcaster";

  if (badges.some((badge) => badge.set_id === "moderator")) return "moderator";

  if (badges.some((badge) => badge.set_id === "vip")) return "vip";

  return "everyone";
}
