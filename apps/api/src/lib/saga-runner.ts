/**
 * SagaRunner - Base class for saga-based Durable Objects
 *
 * Provides step execution with:
 * - Idempotent replay via SQLite cached results
 * - Compensation handler registration for rollback
 * - Exponential backoff retry via DO alarms
 * - Point of no return tracking
 *
 * Usage: Extend this class in your saga DO and call executeStep/executeStepWithRollback
 * for each saga step.
 */

import { Result, TaggedError } from "better-result";
import { and, asc, eq, lte } from "drizzle-orm";

import {
	type SagaRun,
	type SagaStatus,
	type SagaStep,
	type SagaStepState,
	sagaRuns,
	sagaSteps,
} from "../durable-objects/schemas/saga.schema";
import { type SagaEvent, type SagaType, writeSagaLifecycleMetric } from "./analytics";
import {
	SagaAlreadyExistsError,
	SagaCompensationError,
	SagaNotFoundError,
	SagaStepError,
	SagaStepRetrying,
	isRetryableError,
} from "./errors";
import { logger } from "./logger";

import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

// =============================================================================
// SagaRunner Database Error
// =============================================================================

export class SagaRunnerDbError extends TaggedError("SagaRunnerDbError")<{
	operation: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({
			operation: args.operation,
			message: `SagaRunner DB error during ${args.operation}`,
			cause: args.cause,
		});
	}
}

/**
 * Step execution options
 */
export interface StepOptions {
	timeout?: number;
	maxRetries?: number;
}

/**
 * Step execution result with optional undo payload
 */
export interface StepResult<T> {
	result: T;
	undoPayload?: unknown;
}

/**
 * Step handler function
 */
export type StepHandler<T> = () => Promise<StepResult<T>>;

/**
 * Compensation handler function
 */
export type CompensationHandler = (undoPayload: unknown) => Promise<void>;

/**
 * Registered compensation for rollback
 */
interface RegisteredCompensation {
	stepName: string;
	handler: CompensationHandler;
	undoPayload: unknown;
}

/**
 * Default step options
 */
const DEFAULT_STEP_OPTIONS: Required<StepOptions> = {
	timeout: 30000,
	maxRetries: 3,
};

/**
 * SagaRunner - Generic saga execution engine
 *
 * Schema type S must include sagaRuns and sagaSteps tables from saga.schema.ts.
 * Pass your DO's Drizzle database instance to the constructor.
 */
/**
 * Schema type that includes saga tables
 */
type SagaSchema = { sagaRuns: typeof sagaRuns; sagaSteps: typeof sagaSteps };

export class SagaRunner {
	private compensations: RegisteredCompensation[] = [];
	private db: DrizzleSqliteDODatabase<SagaSchema>;
	private stepStartTimes: Map<string, number> = new Map();

	constructor(
		private readonly sagaId: string,
		db: DrizzleSqliteDODatabase<SagaSchema>,
		private readonly ctx: DurableObjectState,
		private readonly analytics?: AnalyticsEngineDataset,
		private readonly sagaType?: SagaType,
	) {
		this.db = db;
	}

	// ===========================================================================
	// Analytics Helpers
	// ===========================================================================

	/**
	 * Emit a saga lifecycle event to Analytics Engine
	 *
	 * No-op if analytics or sagaType not configured.
	 */
	private emit(
		event: SagaEvent,
		extra?: { stepName?: string; error?: string; durationMs?: number },
	): void {
		if (!this.analytics || !this.sagaType) return;
		writeSagaLifecycleMetric(this.analytics, {
			sagaType: this.sagaType,
			sagaId: this.sagaId,
			event,
			...extra,
		});
	}

	/**
	 * Calculate saga duration from createdAt to now
	 */
	private async getSagaDurationMs(): Promise<number> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error" || !sagaResult.value) {
			return 0;
		}
		const createdAt = new Date(sagaResult.value.createdAt).getTime();
		return Date.now() - createdAt;
	}

	/**
	 * Initialize a new saga run
	 */
	async initSaga<P>(params: P): Promise<Result<void, SagaAlreadyExistsError | SagaRunnerDbError>> {
		const now = new Date().toISOString();

		return Result.gen(async function* (this: SagaRunner) {
			const existing = yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db.query.sagaRuns.findFirst({
							where: eq(sagaRuns.id, this.sagaId),
						}),
					catch: (cause) => new SagaRunnerDbError({ operation: "initSaga.findExisting", cause }),
				}),
			);

			if (existing) {
				return Result.err(new SagaAlreadyExistsError({ sagaId: this.sagaId }));
			}

			yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db.insert(sagaRuns).values({
							id: this.sagaId,
							status: "RUNNING" as SagaStatus,
							paramsJson: JSON.stringify(params),
							createdAt: now,
							updatedAt: now,
						}),
					catch: (cause) => new SagaRunnerDbError({ operation: "initSaga.insert", cause }),
				}),
			);

			// Emit started event (only on fresh insert, not replay)
			this.emit("started");

			logger.info("Initialized saga", { sagaId: this.sagaId });
			return Result.ok();
		}, this);
	}

	/**
	 * Execute a step with idempotent replay
	 *
	 * If the step has already succeeded, returns the cached result.
	 * On failure, schedules retry via DO alarm or marks as failed.
	 */
	async executeStep<T>(
		stepName: string,
		handler: StepHandler<T>,
		options?: StepOptions,
	): Promise<Result<T, SagaStepError | SagaStepRetrying | SagaRunnerDbError>> {
		const opts = { ...DEFAULT_STEP_OPTIONS, ...options };

		return Result.gen(async function* (this: SagaRunner) {
			// 1. Check for cached success (idempotent replay)
			// Treat SUCCEEDED as authoritative even without resultJson (void steps)
			const existing = yield* Result.await(this.getStep(stepName));

			if (existing?.state === "SUCCEEDED") {
				// Don't emit events on replay - already tracked
				logger.debug("Replaying cached step result", { sagaId: this.sagaId, stepName });
				if (existing.resultJson == null) {
					return Result.ok(undefined as T);
				}
				return Result.ok(JSON.parse(existing.resultJson) as T);
			}

			// 2. Increment attempt, update state to PENDING
			const attempt = (existing?.attempt ?? 0) + 1;
			yield* Result.await(this.upsertStep(stepName, "PENDING", attempt));

			// Track step start time for latency calculation
			this.stepStartTimes.set(stepName, Date.now());
			this.emit("step_started", { stepName });

			// 3. Execute step with timeout
			const execResult = await this.executeWithTimeout(handler, opts.timeout);

			// Calculate step duration
			const stepDurationMs = Date.now() - (this.stepStartTimes.get(stepName) ?? Date.now());
			this.stepStartTimes.delete(stepName);

			if (execResult.status === "error") {
				// 4. Handle failure - schedule retry or mark failed
				const error = execResult.error;
				const shouldRetry = isRetryableError(error) && attempt < opts.maxRetries;

				if (shouldRetry) {
					const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
					const nextRetryAt = new Date(Date.now() + delay).toISOString();

					yield* Result.await(this.updateStepRetry(stepName, attempt, nextRetryAt, String(error)));

					// Schedule alarm for retry
					await this.ctx.storage.setAlarm(Date.now() + delay);

					// Note: Don't emit step_failed for retries - will emit on eventual success or permanent failure
					return Result.err(
						new SagaStepRetrying({
							stepName,
							sagaId: this.sagaId,
							attempt,
							nextRetryAt,
						}),
					);
				}

				// Mark permanently failed
				yield* Result.await(this.updateStepFailed(stepName, String(error)));

				// Emit step failure event
				this.emit("step_failed", { stepName, error: String(error), durationMs: stepDurationMs });

				return Result.err(
					new SagaStepError({
						stepName,
						sagaId: this.sagaId,
						error: String(error),
					}),
				);
			}

			// 5. Persist success
			const { result, undoPayload } = execResult.value;
			yield* Result.await(this.updateStepSucceeded(stepName, result, undoPayload));

			// Emit step completion event
			this.emit("step_completed", { stepName, durationMs: stepDurationMs });

			logger.debug("Step executed successfully", { sagaId: this.sagaId, stepName });
			return Result.ok(result);
		}, this);
	}

	/**
	 * Execute a step with compensation handler registration
	 *
	 * Same as executeStep but also registers the compensation handler
	 * for rollback if a later step fails.
	 */
	async executeStepWithRollback<T>(
		stepName: string,
		handler: StepHandler<T>,
		compensate: CompensationHandler,
		options?: StepOptions,
	): Promise<Result<T, SagaStepError | SagaStepRetrying | SagaRunnerDbError>> {
		const result = await this.executeStep(stepName, handler, options);

		if (result.status === "ok") {
			// Get the undo payload from the step record
			const step = await this.getStep(stepName);
			const undoPayload =
				step.status === "ok" && step.value?.undoJson ? JSON.parse(step.value.undoJson) : undefined;

			// Register compensation for this step
			this.compensations.push({
				stepName,
				handler: compensate,
				undoPayload,
			});
		}

		return result;
	}

	/**
	 * Mark the point of no return (e.g., after fulfill redemption)
	 */
	async markPointOfNoReturn(): Promise<Result<void, SagaNotFoundError | SagaRunnerDbError>> {
		const now = new Date().toISOString();

		return Result.gen(async function* (this: SagaRunner) {
			const saga = yield* Result.await(this.getSaga());

			if (!saga) {
				return Result.err(new SagaNotFoundError({ sagaId: this.sagaId }));
			}

			yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db
							.update(sagaRuns)
							.set({ fulfilledAt: now, updatedAt: now })
							.where(eq(sagaRuns.id, this.sagaId)),
					catch: (cause) =>
						new SagaRunnerDbError({ operation: "markPointOfNoReturn.update", cause }),
				}),
			);

			// Emit fulfilled event (point of no return)
			this.emit("fulfilled");

			logger.info("Marked point of no return", { sagaId: this.sagaId });
			return Result.ok();
		}, this);
	}

	/**
	 * Check if point of no return has been reached
	 *
	 * Returns true if either:
	 * - sagaRuns.fulfilledAt is set, OR
	 * - fulfill-redemption step is SUCCEEDED (replay-safe fallback)
	 */
	async isPointOfNoReturnReached(): Promise<Result<boolean, SagaRunnerDbError>> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error") {
			return Result.err(sagaResult.error);
		}

		// Primary check: fulfilledAt marker
		if (sagaResult.value?.fulfilledAt != null) {
			return Result.ok(true);
		}

		// Fallback: check if fulfill-redemption step succeeded (crash-safe)
		const fulfillStep = await this.getStep("fulfill-redemption");
		if (fulfillStep.status === "error") {
			return Result.err(fulfillStep.error);
		}

		return Result.ok(fulfillStep.value?.state === "SUCCEEDED");
	}

	/**
	 * Execute all registered compensations in reverse order
	 *
	 * Called when a step fails to rollback previous steps.
	 * Continues through all compensations even if one fails.
	 */
	async compensateAll(): Promise<Result<void, SagaCompensationError[]>> {
		const now = new Date().toISOString();
		const errors: SagaCompensationError[] = [];

		// Update saga status to COMPENSATING
		await this.db
			.update(sagaRuns)
			.set({ status: "COMPENSATING" as SagaStatus, updatedAt: now })
			.where(eq(sagaRuns.id, this.sagaId));

		// Emit compensating event at start
		this.emit("compensating");

		// Execute compensations in reverse order (LIFO)
		for (const comp of [...this.compensations].reverse()) {
			try {
				await comp.handler(comp.undoPayload);

				// Mark step as compensated
				await this.db
					.update(sagaSteps)
					.set({ state: "COMPENSATED" as SagaStepState })
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, comp.stepName)));

				// Emit per-step compensation success
				this.emit("step_compensated", { stepName: comp.stepName });

				logger.info("Compensated step", { sagaId: this.sagaId, stepName: comp.stepName });
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const compError = new SagaCompensationError({
					stepName: comp.stepName,
					sagaId: this.sagaId,
					error: errorMessage,
				});
				errors.push(compError);

				// Emit per-step compensation failure
				this.emit("step_compensation_failed", { stepName: comp.stepName, error: errorMessage });

				logger.error("Compensation failed", {
					sagaId: this.sagaId,
					stepName: comp.stepName,
					error: compError.message,
				});
			}
		}

		// Clear registered compensations
		this.compensations = [];

		if (errors.length > 0) {
			return Result.err(errors);
		}

		return Result.ok();
	}

	/**
	 * Mark saga as completed
	 */
	async complete(): Promise<Result<void, SagaRunnerDbError>> {
		const now = new Date().toISOString();
		const durationMs = await this.getSagaDurationMs();

		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaRuns)
					.set({ status: "COMPLETED" as SagaStatus, updatedAt: now })
					.where(eq(sagaRuns.id, this.sagaId));

				// Emit completed event with total duration
				this.emit("completed", { durationMs });

				logger.info("Saga completed", { sagaId: this.sagaId, durationMs });
			},
			catch: (cause) => new SagaRunnerDbError({ operation: "complete", cause }),
		});
	}

	/**
	 * Mark saga as failed
	 */
	async fail(error: string): Promise<Result<void, SagaRunnerDbError>> {
		const now = new Date().toISOString();
		const durationMs = await this.getSagaDurationMs();

		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaRuns)
					.set({ status: "FAILED" as SagaStatus, error, updatedAt: now })
					.where(eq(sagaRuns.id, this.sagaId));

				// Emit failed event with error and total duration
				this.emit("failed", { error, durationMs });

				logger.info("Saga failed", { sagaId: this.sagaId, error, durationMs });
			},
			catch: (cause) => new SagaRunnerDbError({ operation: "fail", cause }),
		});
	}

	/**
	 * Get the current saga run
	 */
	async getSaga(): Promise<Result<SagaRun | undefined, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: () =>
				this.db.query.sagaRuns.findFirst({
					where: eq(sagaRuns.id, this.sagaId),
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: "getSaga", cause }),
		});
	}

	/**
	 * Check if saga is in RUNNING state (ok to proceed with execution)
	 *
	 * Returns true if saga exists and is RUNNING, false otherwise.
	 * Use to gate execute() to prevent re-entry during compensation or after completion.
	 */
	async isRunning(): Promise<Result<boolean, SagaRunnerDbError>> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error") {
			return Result.err(sagaResult.error);
		}

		return Result.ok(sagaResult.value?.status === "RUNNING");
	}

	/**
	 * Get saga parameters
	 */
	async getParams<P>(): Promise<Result<P | undefined, SagaNotFoundError | SagaRunnerDbError>> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error") {
			return Result.err(sagaResult.error);
		}

		if (!sagaResult.value) {
			return Result.err(new SagaNotFoundError({ sagaId: this.sagaId }));
		}

		return Result.ok(JSON.parse(sagaResult.value.paramsJson) as P);
	}

	/**
	 * Get step that needs retry (scheduled for now or earlier)
	 *
	 * Returns the earliest pending step with nextRetryAt <= now
	 */
	async getPendingRetryStep(): Promise<Result<SagaStep | undefined, SagaRunnerDbError>> {
		const now = new Date().toISOString();

		return Result.tryPromise({
			try: () =>
				this.db.query.sagaSteps.findFirst({
					where: and(
						eq(sagaSteps.sagaId, this.sagaId),
						eq(sagaSteps.state, "PENDING"),
						lte(sagaSteps.nextRetryAt, now),
					),
					orderBy: [asc(sagaSteps.nextRetryAt)],
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: "getPendingRetryStep", cause }),
		});
	}

	/**
	 * Schedule a retry alarm
	 */
	async scheduleRetry(delayMs: number): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + delayMs);
		logger.debug("Scheduled retry alarm", { sagaId: this.sagaId, delayMs });
	}

	// ===========================================================================
	// Private helpers
	// ===========================================================================

	private async getStep(
		stepName: string,
	): Promise<Result<SagaStep | undefined, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: () =>
				this.db.query.sagaSteps.findFirst({
					where: and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)),
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: `getStep(${stepName})`, cause }),
		});
	}

	private async upsertStep(
		stepName: string,
		state: SagaStepState,
		attempt: number,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.insert(sagaSteps)
					.values({
						sagaId: this.sagaId,
						stepName,
						state,
						attempt,
					})
					.onConflictDoUpdate({
						target: [sagaSteps.sagaId, sagaSteps.stepName],
						set: { state, attempt },
					});
			},
			catch: (cause) => new SagaRunnerDbError({ operation: `upsertStep(${stepName})`, cause }),
		});
	}

	private async updateStepSucceeded<T>(
		stepName: string,
		result: T,
		undoPayload?: unknown,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaSteps)
					.set({
						state: "SUCCEEDED" as SagaStepState,
						// Store null for undefined results to ensure idempotent replay works
						resultJson: JSON.stringify(result ?? null),
						undoJson: undoPayload !== undefined ? JSON.stringify(undoPayload) : null,
						lastError: null,
						nextRetryAt: null,
					})
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) =>
				new SagaRunnerDbError({ operation: `updateStepSucceeded(${stepName})`, cause }),
		});
	}

	private async updateStepFailed(
		stepName: string,
		error: string,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaSteps)
					.set({
						state: "FAILED" as SagaStepState,
						lastError: error,
						nextRetryAt: null,
					})
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) =>
				new SagaRunnerDbError({ operation: `updateStepFailed(${stepName})`, cause }),
		});
	}

	private async updateStepRetry(
		stepName: string,
		attempt: number,
		nextRetryAt: string,
		error: string,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaSteps)
					.set({
						state: "PENDING" as SagaStepState,
						attempt,
						nextRetryAt,
						lastError: error,
					})
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) => new SagaRunnerDbError({ operation: `updateStepRetry(${stepName})`, cause }),
		});
	}

	private async executeWithTimeout<T>(
		handler: StepHandler<T>,
		timeoutMs: number,
	): Promise<Result<StepResult<T>, Error>> {
		return Result.tryPromise({
			try: () =>
				Promise.race([
					handler(),
					new Promise<StepResult<T>>((_, reject) =>
						setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs),
					),
				]),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
	}
}
