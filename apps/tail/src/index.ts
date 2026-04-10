/* oxlint-disable eslint/no-console */
/**
 * Tail Worker for error monitoring and analytics
 */

export interface Env extends Cloudflare.Env {}

type TailLogLevel = "debug" | "info" | "warn" | "error";

function emitTailLog(level: TailLogLevel, message: string, attrs: Record<string, unknown>): void {
	const payload = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		component: "tail",
		message,
		...attrs,
	});

	switch (level) {
		case "debug":
			console.debug(payload);
			break;
		case "info":
			console.info(payload);
			break;
		case "warn":
			console.warn(payload);
			break;
		case "error":
			console.error(payload);
			break;
	}
}

export default {
	async tail(events: TraceItem[], env: Env, _ctx: ExecutionContext) {
		emitTailLog("info", "Tail batch received", {
			event: "tail.batch.received",
			event_count: events.length,
		});

		for (const event of events) {
			if (event.outcome !== "exception" && event.outcome !== "exceededCpu") {
				continue;
			}

			const timestamp = event.eventTimestamp ? new Date(event.eventTimestamp) : new Date();
			const exceptionCount = Array.isArray(event.exceptions) ? event.exceptions.length : 0;

			emitTailLog("error", "Tail trace error detected", {
				event: "tail.trace.error_detected",
				script_name: event.scriptName ?? "unknown",
				outcome: event.outcome,
				exception_count: exceptionCount,
				timestamp: timestamp.toISOString(),
			});

			try {
				env.ANALYTICS.writeDataPoint({
					blobs: [event.scriptName ?? "unknown", event.outcome, JSON.stringify(event.exceptions)],
					doubles: [timestamp.getTime()],
					indexes: ["error"],
				});
			} catch (error) {
				emitTailLog("error", "Tail analytics write failed", {
					event: "tail.analytics.write_failed",
					script_name: event.scriptName ?? "unknown",
					outcome: event.outcome,
					error_message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	},
};
