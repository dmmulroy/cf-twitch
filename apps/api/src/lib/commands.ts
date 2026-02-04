/**
 * Chat command parsing utilities.
 */

export interface ParsedCommand {
	command: string;
	arg: string | null;
}

/**
 * Parse a chat message into command and optional argument.
 *
 * @param text - Raw chat message text
 * @returns Parsed command (lowercase, no !) and first argument, or null if invalid
 *
 * @example
 * parseCommandWithArg("!achievements user123") // { command: "achievements", arg: "user123" }
 * parseCommandWithArg("!dotfiles")              // { command: "dotfiles", arg: null }
 * parseCommandWithArg("hello world")            // null (no ! prefix)
 */
export function parseCommandWithArg(text: string): ParsedCommand | null {
	const parts = text.trim().split(/\s+/);
	const firstPart = parts[0];

	if (!firstPart || !firstPart.startsWith("!")) {
		return null;
	}

	const command = firstPart.slice(1).toLowerCase();
	if (!command) return null;

	const arg = parts.length > 1 ? parts.slice(1).join(" ") : null;

	return { command, arg };
}
