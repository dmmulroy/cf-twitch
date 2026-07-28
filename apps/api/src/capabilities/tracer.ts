import type { Logger } from "../lib/logging";

/** Bounded scalar value permitted on tracing spans. */
export type TraceAttribute = string | number | boolean | null | undefined;

/** Runs asynchronous work inside one named tracing span. */
export interface Tracer {
	/** Records one operation without requiring tracing arguments on domain methods. */
	span<T>(
		name: string,
		attributes: Readonly<Record<string, TraceAttribute>>,
		run: () => Promise<T>,
	): Promise<T>;
}

/** Logger-backed tracer used until a distributed tracing exporter is configured. */
export class LoggingTracer implements Tracer {
	constructor(private readonly logger: Logger) {}

	/** Records span start, completion, duration, and safe failure classification. */
	async span<T>(
		name: string,
		attributes: Readonly<Record<string, TraceAttribute>>,
		run: () => Promise<T>,
	): Promise<T> {
		const startedAt = Date.now();
		this.logger.debug("Tracing span started", {
			event: "trace.span.started",
			span_name: name,
			...attributes,
		});
		try {
			const value = await run();
			this.logger.debug("Tracing span completed", {
				event: "trace.span.completed",
				span_name: name,
				duration_ms: Date.now() - startedAt,
				...attributes,
			});
			return value;
		} catch (cause) {
			this.logger.error("Tracing span failed", {
				event: "trace.span.failed",
				span_name: name,
				duration_ms: Date.now() - startedAt,
				error: cause,
				...attributes,
			});
			throw cause;
		}
	}
}
