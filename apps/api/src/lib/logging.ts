import type { LogContext } from "./logger";

/**
 * Structural logger seam for modules that need contextual logs without depending on a concrete logger.
 *
 * @param message - Human-readable log message.
 * @param context - Optional structured context merged into the log event.
 * @returns Nothing for log methods, or a child logger for child.
 */
export interface Logger {
	debug(message: string, context?: LogContext): void;
	info(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext): void;
	error(message: string, context?: LogContext): void;
	child(context: LogContext): Logger;
}
