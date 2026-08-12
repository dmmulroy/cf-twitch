/**
 * Structural logger seam for modules that need contextual logs without depending on a concrete logger.
 *
 * @param message - Human-readable log message.
 * @param context - Optional structured context merged into the log event.
 * @returns Nothing for log methods, or a child logger for child.
 */
export interface Logger {
	debug<Context extends object>(message: string, context?: Context): void;
	info<Context extends object>(message: string, context?: Context): void;
	warn<Context extends object>(message: string, context?: Context): void;
	error<Context extends object>(message: string, context?: Context): void;
	child<Context extends object>(context: Context): Logger;
}
