import type { ChatCommandPermission } from "@cf-twitch/contracts/chat-command";

const commandPermissionRanks = { everyone: 0, vip: 1, moderator: 2, broadcaster: 3 };

/** Check read or write permission using the same broadcaster > moderator > VIP hierarchy. */
export function hasCommandPermission(
  actual: ChatCommandPermission,
  required: ChatCommandPermission,
): boolean {
  return commandPermissionRanks[actual] >= commandPermissionRanks[required];
}

/** Derive highest permission from verified Twitch badges; subscribers gain no write privilege. */
export function getChatCommandPermission(
  badges: readonly { readonly set_id: string }[],
): ChatCommandPermission {
  if (badges.some((badge) => badge.set_id === "broadcaster")) return "broadcaster";

  if (badges.some((badge) => badge.set_id === "moderator")) return "moderator";

  if (badges.some((badge) => badge.set_id === "vip")) return "vip";

  return "everyone";
}
