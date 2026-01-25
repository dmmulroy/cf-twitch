/**
 * Logger utility for structured logging
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
	[key: string]: unknown;
}

class Logger {
	/**
	 * Log a debug message
	 */
	debug(message: string, context?: LogContext): void {
		this.log("debug", message, context);
	}

	/**
	 * Log an info message
	 */
	info(message: string, context?: LogContext): void {
		this.log("info", message, context);
	}

	/**
	 * Log a warning message
	 */
	warn(message: string, context?: LogContext): void {
		this.log("warn", message, context);
	}

	/**
	 * Log an error message
	 */
	error(message: string, context?: LogContext): void {
		this.log("error", message, context);
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
		const logData = {
			level,
			message,
			timestamp: new Date().toISOString(),
			...context,
		};

		// Use appropriate console method based on level
		switch (level) {
			case "debug":
				console.debug(JSON.stringify(logData));
				break;
			case "info":
				console.info(JSON.stringify(logData));
				break;
			case "warn":
				console.warn(JSON.stringify(logData));
				break;
			case "error":
				console.error(JSON.stringify(logData));
				break;
		}
	}
}

export const logger = new Logger();
