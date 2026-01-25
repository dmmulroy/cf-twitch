/**
 * Tail Worker for error monitoring and analytics
 */

export interface Env extends Cloudflare.Env {}

export default {
	async tail(events: TraceItem[], env: Env, _ctx: ExecutionContext) {
		for (const event of events) {
			if (event.outcome === "exception" || event.outcome === "exceededCpu") {
				const timestamp = event.eventTimestamp ? new Date(event.eventTimestamp) : new Date();

				env.ANALYTICS.writeDataPoint({
					blobs: [event.scriptName ?? "unknown", event.outcome, JSON.stringify(event.exceptions)],
					doubles: [timestamp.getTime()],
					indexes: ["error"],
				});
			}
		}
	},
};
