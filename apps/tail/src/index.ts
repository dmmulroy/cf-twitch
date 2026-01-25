/**
 * Tail Worker for error monitoring and analytics
 *
 * Writes worker_error metrics for exceptions and CPU exceeded events.
 * Schema: blobs=[script, outcome], doubles=[], index=worker_error
 *
 * Separate from app_error (API/DO errors) to distinguish infrastructure
 * failures from application-level errors.
 */

export interface Env extends Cloudflare.Env {}

export default {
	async tail(events: TraceItem[], env: Env, _ctx: ExecutionContext) {
		for (const event of events) {
			if (event.outcome === "exception" || event.outcome === "exceededCpu") {
				env.ANALYTICS.writeDataPoint({
					blobs: [event.scriptName ?? "unknown", event.outcome],
					doubles: [],
					indexes: ["worker_error"],
				});
			}
		}
	},
};
