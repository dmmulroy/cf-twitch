import { writeChatCommandMetric } from "../analytics";

import type { ChatCommandMetric, ChatCommandMetrics } from "./types";

/**
 * Analytics Engine backed metric sink for chat command executions.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Chat command metric payload to write.
 * @returns Nothing.
 */
export class AnalyticsEngineChatCommandMetrics implements ChatCommandMetrics {
	constructor(private readonly analytics: AnalyticsEngineDataset) {}

	write(metric: ChatCommandMetric): void {
		writeChatCommandMetric(this.analytics, {
			command: metric.command,
			userId: metric.userId,
			userName: metric.userName,
			status: metric.status,
			durationMs: metric.durationMs,
			error: metric.error,
		});
	}
}
