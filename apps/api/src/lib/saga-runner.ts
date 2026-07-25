import { Result, TaggedError } from "better-result";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { z } from "zod";

import {
	type SagaRun,
	type SagaStep,
	type SagaStepState,
	SagaRunRowSchema,
	SagaStepRowSchema,
	sagaRuns,
	sagaSteps,
} from "../durable-objects/schemas/saga.schema";
import { type SagaEvent, type SagaType, writeSagaLifecycleMetric } from "./analytics";
import { type SagaCodec } from "./codecs";
import {
	SagaAlreadyExistsError,
	SagaCompensationError,
	SagaEffectOutcomeUnknown,
	SagaNotFoundError,
	SagaPersistedDataError,
	SagaScheduleError,
	SagaStepError,
	SagaStepRetrying,
	getRetryDelayMs,
	isAmbiguousExternalEffectError,
	isRetryableError,
} from "./errors";
import { logger } from "./logger";
import { parsePersistedJson, stringifyPersistedJson } from "./saga-codecs";

import type { SagaPersistedField } from "./errors";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

/** Timeout and retry policy for one saga step. */
export interface StepOptions {
	readonly timeout?: number;
	readonly maxRetries?: number;
	/** Marks transport failures as outcome-unknown instead of blindly repeating a mutation. */
	readonly ambiguousEffect?: boolean;
	/** Retries typed failures for idempotent steps whose adapter has no shared retry classification. */
	readonly retryAllErrors?: boolean;
}

/** A codec-aware definition for a non-rollbackable saga step. */
export interface SagaStepDefinition<T> {
	readonly name: string;
	readonly resultCodec: SagaCodec<T>;
	readonly options?: StepOptions;
}

/** A codec-aware definition for a rollbackable saga step. */
export interface SagaRollbackStepDefinition<T, Undo> {
	readonly name: string;
	readonly resultCodec: SagaCodec<T>;
	readonly undoCodec: SagaCodec<Undo>;
	readonly options?: StepOptions;
}

/** Required successful value returned by a non-rollbackable step handler. */
export interface SagaStepSuccess<T> {
	readonly result: T;
}

/** Required result and compensation evidence returned by a rollbackable step handler. */
export interface SagaRollbackStepSuccess<T, Undo> extends SagaStepSuccess<T> {
	readonly undoPayload: Undo;
}

/** Handler for a non-rollbackable saga step. */
export type SagaStepHandler<T> = (signal: AbortSignal) => Promise<SagaStepSuccess<T>>;

/** Handler for a rollbackable saga step. */
export type SagaRollbackStepHandler<T, Undo> = (
	signal: AbortSignal,
) => Promise<SagaRollbackStepSuccess<T, Undo>>;

/** Compensation handler receiving a parsed canonical undo value. */
export type SagaCompensationHandler<Undo> = (undoPayload: Undo) => Promise<void>;

/** Narrow capability used by the runner to request retry scheduling. */
export interface SagaRetryScheduler {
	scheduleRetry(delayMs: number): Promise<Result<void, SagaScheduleError>>;
}

/** Expected infrastructure failures returned by the typed runner. */
export type SagaRunnerError = SagaRunnerDbError | SagaPersistedDataError | SagaScheduleError;

/** Expected failures returned while executing a typed saga step. */
export type SagaStepExecutionError =
	| SagaStepError
	| SagaStepRetrying
	| SagaEffectOutcomeUnknown
	| SagaRunnerError;

type SagaSchema = { sagaRuns: typeof sagaRuns; sagaSteps: typeof sagaSteps };

/** Expected failure while the saga runner accesses SQLite persistence. */
export class SagaRunnerDbError extends TaggedError("SagaRunnerDbError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: { readonly operation: string; readonly cause?: unknown }) {
		super({
			...args,
			message: `SagaRunner DB error during ${args.operation}`,
		});
	}
}

type RegisteredCompensation = {
	readonly stepName: string;
	readonly run: () => Promise<void>;
};

type PersistedValueContext = {
	readonly field: SagaPersistedField;
	readonly stepName?: string;
};

const DEFAULT_STEP_OPTIONS: Required<StepOptions> = {
	timeout: 30000,
	maxRetries: 3,
	ambiguousEffect: false,
	retryAllErrors: false,
};

function errorTag(error: unknown): string {
	if (typeof error !== "object" || error === null || !("_tag" in error)) return "UnknownError";
	return typeof error._tag === "string" ? error._tag : "UnknownError";
}

/** Construction dependencies for a typed saga runner. */
export interface SagaRunnerArgs<P> {
	readonly sagaId: string;
	readonly db: DrizzleSqliteDODatabase<SagaSchema>;
	readonly paramsCodec: SagaCodec<P>;
	readonly retryScheduler: SagaRetryScheduler;
	readonly analytics?: AnalyticsEngineDataset;
	readonly sagaType?: SagaType;
}

/**
 * Executes a saga while enforcing codecs at every SQLite persistence boundary.
 *
 * Successful rows are authoritative: replay decoding failures are returned and
 * their handlers are never invoked again.
 */
export class SagaRunner<P> {
	private readonly compensations: RegisteredCompensation[] = [];
	private retryCallbackExecution = false;
	private readonly db: DrizzleSqliteDODatabase<SagaSchema>;
	private readonly stepStartTimes = new Map<string, number>();
	private readonly sagaId: string;
	private readonly paramsCodec: SagaCodec<P>;
	private readonly retryScheduler: SagaRetryScheduler;
	private readonly analytics: AnalyticsEngineDataset | undefined;
	private readonly sagaType: SagaType | undefined;

	constructor(args: SagaRunnerArgs<P>) {
		this.sagaId = args.sagaId;
		this.db = args.db;
		this.paramsCodec = args.paramsCodec;
		this.retryScheduler = args.retryScheduler;
		this.analytics = args.analytics;
		this.sagaType = args.sagaType;
	}

	/** Clears process-local handlers before one orchestration replay reconstructs them. */
	prepareExecution(options: { readonly retryCallback: boolean }): void {
		this.compensations.length = 0;
		this.retryCallbackExecution = options.retryCallback;
	}

	/** Encodes and inserts the canonical parameters for a new saga. */
	async initSaga(
		params: P,
	): Promise<Result<void, SagaAlreadyExistsError | SagaRunnerDbError | SagaPersistedDataError>> {
		const existingResult = await Result.tryPromise({
			try: () =>
				this.db.query.sagaRuns.findFirst({
					where: eq(sagaRuns.id, this.sagaId),
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: "initSaga.findExisting", cause }),
		});
		if (existingResult.status === "error") return Result.err(existingResult.error);
		if (existingResult.value) {
			return Result.err(new SagaAlreadyExistsError({ sagaId: this.sagaId }));
		}

		const paramsJsonResult = this.encodePersisted(this.paramsCodec, params, { field: "params" });
		if (paramsJsonResult.status === "error") return Result.err(paramsJsonResult.error);

		const now = new Date().toISOString();
		const insertResult = await Result.tryPromise({
			try: () =>
				this.db.insert(sagaRuns).values({
					id: this.sagaId,
					status: "RUNNING",
					paramsJson: paramsJsonResult.value,
					createdAt: now,
					updatedAt: now,
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: "initSaga.insert", cause }),
		});
		if (insertResult.status === "error") return Result.err(insertResult.error);

		this.emit("started");
		logger.info("Initialized saga", { sagaId: this.sagaId });
		return Result.ok();
	}

	/** Loads and parses the canonical parameters originally persisted for this saga. */
	async getParams(): Promise<
		Result<P, SagaNotFoundError | SagaRunnerDbError | SagaPersistedDataError>
	> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error") return Result.err(sagaResult.error);
		if (!sagaResult.value) {
			return Result.err(new SagaNotFoundError({ sagaId: this.sagaId }));
		}

		return this.decodePersisted(this.paramsCodec, sagaResult.value.paramsJson, {
			field: "params",
		});
	}

	/** Executes or safely replays a non-rollbackable typed step. */
	async executeStep<T>(
		step: SagaStepDefinition<T>,
		handler: SagaStepHandler<T>,
	): Promise<Result<T, SagaStepExecutionError>> {
		return this.runStep(
			step,
			handler,
			(result) => Result.ok(result),
			async (success) => {
				const resultJson = this.encodePersisted(step.resultCodec, success.result, {
					field: "step-result",
					stepName: step.name,
				});
				if (resultJson.status === "error") return Result.err(resultJson.error);

				const updateResult = await this.updateStepSucceeded(step.name, resultJson.value, null);
				if (updateResult.status === "error") return Result.err(updateResult.error);
				return Result.ok(success.result);
			},
		);
	}

	/** Executes or safely replays a rollbackable typed step and registers compensation. */
	async executeStepWithRollback<T, Undo>(
		step: SagaRollbackStepDefinition<T, Undo>,
		handler: SagaRollbackStepHandler<T, Undo>,
		compensate: SagaCompensationHandler<Undo>,
	): Promise<Result<T, SagaStepExecutionError>> {
		return this.runStep(
			step,
			handler,
			(result, existing) => {
				if (existing.undoJson === null) {
					return Result.err(
						this.persistedDataError(
							step.undoCodec,
							"step-undo",
							"Missing persisted JSON",
							step.name,
						),
					);
				}

				const undoResult = this.decodePersisted(step.undoCodec, existing.undoJson, {
					field: "step-undo",
					stepName: step.name,
				});
				if (undoResult.status === "error") return Result.err(undoResult.error);

				const undoPayload = undoResult.value;
				this.compensations.push({
					stepName: step.name,
					run: () => compensate(undoPayload),
				});
				return Result.ok(result);
			},
			async (success) => {
				const resultJson = this.encodePersisted(step.resultCodec, success.result, {
					field: "step-result",
					stepName: step.name,
				});
				if (resultJson.status === "error") return Result.err(resultJson.error);

				const undoJson = this.encodePersisted(step.undoCodec, success.undoPayload, {
					field: "step-undo",
					stepName: step.name,
				});
				if (undoJson.status === "error") return Result.err(undoJson.error);

				const updateResult = await this.updateStepSucceeded(
					step.name,
					resultJson.value,
					undoJson.value,
				);
				if (updateResult.status === "error") return Result.err(updateResult.error);

				const undoPayload = success.undoPayload;
				this.compensations.push({
					stepName: step.name,
					run: () => compensate(undoPayload),
				});
				return Result.ok(success.result);
			},
		);
	}

	/** Marks this saga's point of no return. */
	async markPointOfNoReturn(): Promise<
		Result<void, SagaNotFoundError | SagaRunnerDbError | SagaPersistedDataError>
	> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error") return Result.err(sagaResult.error);
		if (!sagaResult.value) {
			return Result.err(new SagaNotFoundError({ sagaId: this.sagaId }));
		}

		const now = new Date().toISOString();
		const updateResult = await Result.tryPromise({
			try: () =>
				this.db
					.update(sagaRuns)
					.set({ fulfilledAt: now, updatedAt: now })
					.where(eq(sagaRuns.id, this.sagaId)),
			catch: (cause) => new SagaRunnerDbError({ operation: "markPointOfNoReturn.update", cause }),
		});
		if (updateResult.status === "error") return Result.err(updateResult.error);

		this.emit("fulfilled");
		logger.info("Marked point of no return", { sagaId: this.sagaId });
		return Result.ok();
	}

	/** Reports whether irreversible saga work has succeeded. */
	async isPointOfNoReturnReached(): Promise<
		Result<boolean, SagaRunnerDbError | SagaPersistedDataError>
	> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error") return Result.err(sagaResult.error);
		if (sagaResult.value?.fulfilledAt !== null && sagaResult.value?.fulfilledAt !== undefined) {
			return Result.ok(true);
		}

		const fulfillStep = await this.getStep("fulfill-redemption");
		if (fulfillStep.status === "error") return Result.err(fulfillStep.error);
		return Result.ok(fulfillStep.value?.state === "SUCCEEDED");
	}

	/** Runs durable, resumable compensations in reverse order. */
	async compensateAll(): Promise<
		Result<
			void,
			| SagaCompensationError[]
			| SagaStepRetrying
			| SagaScheduleError
			| SagaRunnerDbError
			| SagaPersistedDataError
		>
	> {
		const phaseUpdate = await this.updateSagaStatus("COMPENSATING", null);
		if (phaseUpdate.status === "error") return Result.err(phaseUpdate.error);
		this.emit("compensating");

		for (const compensation of [...this.compensations].reverse()) {
			const persisted = await this.getStep(compensation.stepName);
			if (persisted.status === "error") return Result.err(persisted.error);
			if (persisted.value?.state === "COMPENSATED") continue;

			if (
				!this.retryCallbackExecution &&
				persisted.value?.state === "COMPENSATION_PENDING" &&
				persisted.value.nextRetryAt !== null &&
				persisted.value.nextRetryAt > new Date().toISOString()
			) {
				const scheduled = await this.retryScheduler.scheduleRetry(
					Math.max(0, new Date(persisted.value.nextRetryAt).getTime() - Date.now()),
				);
				if (scheduled.status === "error") return Result.err(scheduled.error);
				return Result.err(
					new SagaStepRetrying({
						stepName: compensation.stepName,
						sagaId: this.sagaId,
						attempt: persisted.value.attempt,
						nextRetryAt: persisted.value.nextRetryAt,
					}),
				);
			}

			try {
				await compensation.run();
				const completed = await this.updateStepCompensated(compensation.stepName);
				if (completed.status === "error") return Result.err(completed.error);
				this.emit("step_compensated", { stepName: compensation.stepName });
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const attempt = (persisted.value?.attempt ?? 0) + 1;
				const compensationError = new SagaCompensationError({
					stepName: compensation.stepName,
					sagaId: this.sagaId,
					error: errorMessage,
				});
				this.emit("step_compensation_failed", {
					stepName: compensation.stepName,
					error: errorMessage,
				});

				if (attempt >= 5) {
					const exhausted = await this.updateStepFailed(compensation.stepName, errorMessage);
					if (exhausted.status === "error") return Result.err(exhausted.error);
					const terminal = await this.updateSagaStatus(
						"COMPENSATION_FAILED",
						compensationError.message,
					);
					return terminal.status === "error"
						? Result.err(terminal.error)
						: Result.err([compensationError]);
				}

				const delay = Math.min(30000, 1000 * 2 ** attempt);
				const nextRetryAt = new Date(Date.now() + delay).toISOString();
				const pending = await this.updateStepCompensationRetry(
					compensation.stepName,
					attempt,
					nextRetryAt,
					errorMessage,
				);
				if (pending.status === "error") return Result.err(pending.error);
				const scheduled = await this.retryScheduler.scheduleRetry(delay);
				if (scheduled.status === "error") return Result.err(scheduled.error);
				return Result.err(
					new SagaStepRetrying({
						stepName: compensation.stepName,
						sagaId: this.sagaId,
						attempt,
						nextRetryAt,
					}),
				);
			}
		}

		this.compensations.length = 0;
		return Result.ok();
	}

	/** Executes durable compensation work such as a Channel Point Redemption refund. */
	async executeCompensationStep(
		stepName: string,
		handler: (signal: AbortSignal) => Promise<void>,
		options: StepOptions = {},
	): Promise<Result<void, SagaStepExecutionError>> {
		const policy = { ...DEFAULT_STEP_OPTIONS, ...options };
		const existing = await this.getStep(stepName);
		if (existing.status === "error") return Result.err(existing.error);
		if (existing.value?.state === "COMPENSATED") return Result.ok();
		if (existing.value?.state === "FAILED") {
			return Result.err(
				new SagaStepError({
					stepName,
					sagaId: this.sagaId,
					causeTag: "CompensationRetryExhausted",
					error: existing.value.lastError ?? "Compensation retry exhausted",
				}),
			);
		}
		if (
			!this.retryCallbackExecution &&
			existing.value?.nextRetryAt !== null &&
			existing.value?.nextRetryAt !== undefined &&
			existing.value.nextRetryAt > new Date().toISOString()
		) {
			const scheduled = await this.retryScheduler.scheduleRetry(
				Math.max(0, new Date(existing.value.nextRetryAt).getTime() - Date.now()),
			);
			if (scheduled.status === "error") return Result.err(scheduled.error);
			return Result.err(
				new SagaStepRetrying({
					stepName,
					sagaId: this.sagaId,
					attempt: existing.value.attempt,
					nextRetryAt: existing.value.nextRetryAt,
				}),
			);
		}

		const attempt = (existing.value?.attempt ?? 0) + 1;
		const pending = await this.upsertStep(stepName, "COMPENSATION_PENDING", attempt);
		if (pending.status === "error") return Result.err(pending.error);
		const result = await this.executeWithTimeout(handler, policy.timeout);
		if (result.status === "ok") {
			const compensated = await this.updateStepCompensated(stepName);
			return compensated.status === "error" ? Result.err(compensated.error) : Result.ok();
		}

		if (attempt < policy.maxRetries) {
			const exponentialDelay = Math.min(30000, 1000 * 2 ** attempt);
			const delay = getRetryDelayMs(result.error, exponentialDelay);
			const nextRetryAt = new Date(Date.now() + delay).toISOString();
			const retry = await this.updateStepCompensationRetry(
				stepName,
				attempt,
				nextRetryAt,
				String(result.error),
			);
			if (retry.status === "error") return Result.err(retry.error);
			const scheduled = await this.retryScheduler.scheduleRetry(delay);
			if (scheduled.status === "error") return Result.err(scheduled.error);
			return Result.err(
				new SagaStepRetrying({ stepName, sagaId: this.sagaId, attempt, nextRetryAt }),
			);
		}

		const exhausted = await this.updateStepFailed(stepName, String(result.error));
		if (exhausted.status === "error") return Result.err(exhausted.error);
		const compensationFailed = await this.updateSagaStatus(
			"COMPENSATION_FAILED",
			`Compensation retry exhausted for ${stepName}`,
		);
		if (compensationFailed.status === "error") return Result.err(compensationFailed.error);
		return Result.err(
			new SagaStepError({
				stepName,
				sagaId: this.sagaId,
				causeTag: errorTag(result.error),
				error: String(result.error),
			}),
		);
	}

	/** Marks this saga complete. */
	async complete(): Promise<Result<void, SagaRunnerDbError>> {
		const durationMs = await this.getSagaDurationMs();
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaRuns)
					.set({ status: "COMPLETED", updatedAt: new Date().toISOString() })
					.where(eq(sagaRuns.id, this.sagaId));
				this.emit("completed", { durationMs });
				logger.info("Saga completed", { sagaId: this.sagaId, durationMs });
			},
			catch: (cause) => new SagaRunnerDbError({ operation: "complete", cause }),
		});
	}

	/** Marks an unreconciled external mutation without claiming failure or compensation. */
	async markOutcomeUnknown(error: string): Promise<Result<void, SagaRunnerDbError>> {
		return this.updateSagaStatus("OUTCOME_UNKNOWN", error);
	}

	/** Marks required post-fulfillment work exhausted without overstating completion. */
	async markPostCommitFailed(error: string): Promise<Result<void, SagaRunnerDbError>> {
		return this.updateSagaStatus("POST_COMMIT_FAILED", error);
	}

	/** Marks this saga failed with a safe caller-provided summary. */
	async fail(error: string): Promise<Result<void, SagaRunnerDbError>> {
		const durationMs = await this.getSagaDurationMs();
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaRuns)
					.set({ status: "FAILED", error, updatedAt: new Date().toISOString() })
					.where(eq(sagaRuns.id, this.sagaId));
				this.emit("failed", { error, durationMs });
				logger.info("Saga failed", { sagaId: this.sagaId, error, durationMs });
			},
			catch: (cause) => new SagaRunnerDbError({ operation: "fail", cause }),
		});
	}

	/** Loads the current saga run row. */
	async getSaga(): Promise<
		Result<SagaRun | undefined, SagaRunnerDbError | SagaPersistedDataError>
	> {
		const loaded = await Result.tryPromise({
			try: () =>
				this.db.query.sagaRuns.findFirst({
					where: eq(sagaRuns.id, this.sagaId),
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: "getSaga", cause }),
		});
		if (loaded.status === "error" || loaded.value === undefined) return loaded;
		const parsed = SagaRunRowSchema.safeParse(loaded.value);
		return parsed.success
			? Result.ok(parsed.data)
			: Result.err(
					new SagaPersistedDataError({
						sagaId: this.sagaId,
						field: "run-row",
						codecName: "saga-run-row",
						parseError: z.prettifyError(parsed.error),
					}),
				);
	}

	/** Reports whether this saga exists in the running state. */
	async isRunning(): Promise<Result<boolean, SagaRunnerDbError | SagaPersistedDataError>> {
		const sagaResult = await this.getSaga();
		return sagaResult.status === "error"
			? Result.err(sagaResult.error)
			: Result.ok(sagaResult.value?.status === "RUNNING");
	}

	/** Loads the earliest pending retry step, including future due times. */
	async getNextRetryStep(): Promise<
		Result<SagaStep | undefined, SagaRunnerDbError | SagaPersistedDataError>
	> {
		const loaded = await Result.tryPromise({
			try: () =>
				this.db.query.sagaSteps.findFirst({
					where: and(
						eq(sagaSteps.sagaId, this.sagaId),
						or(eq(sagaSteps.state, "PENDING"), eq(sagaSteps.state, "COMPENSATION_PENDING")),
						isNotNull(sagaSteps.nextRetryAt),
					),
					orderBy: [asc(sagaSteps.nextRetryAt)],
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: "getNextRetryStep", cause }),
		});
		if (loaded.status === "error" || loaded.value === undefined) return loaded;
		return this.getStep(loaded.value.stepName);
	}

	private async runStep<T, Success extends SagaStepSuccess<T>>(
		step: SagaStepDefinition<T>,
		handler: (signal: AbortSignal) => Promise<Success>,
		onReplay: (result: T, existing: SagaStep) => Result<T, SagaPersistedDataError>,
		onFresh: (success: Success) => Promise<Result<T, SagaPersistedDataError | SagaRunnerDbError>>,
	): Promise<Result<T, SagaStepExecutionError>> {
		const options = { ...DEFAULT_STEP_OPTIONS, ...step.options };
		const existingResult = await this.getStep(step.name);
		if (existingResult.status === "error") return Result.err(existingResult.error);
		const existing = existingResult.value;

		if (
			existing?.state === "SUCCEEDED" ||
			existing?.state === "COMPENSATION_PENDING" ||
			existing?.state === "COMPENSATED"
		) {
			logger.debug("Replaying cached step result", { sagaId: this.sagaId, stepName: step.name });
			if (existing.resultJson === null) {
				return Result.err(
					this.persistedDataError(
						step.resultCodec,
						"step-result",
						"Missing persisted JSON",
						step.name,
					),
				);
			}

			const decoded = this.decodePersisted(step.resultCodec, existing.resultJson, {
				field: "step-result",
				stepName: step.name,
			});
			if (decoded.status === "error") return Result.err(decoded.error);
			return existing.state === "COMPENSATED"
				? Result.ok(decoded.value)
				: onReplay(decoded.value, existing);
		}

		if (
			options.ambiguousEffect &&
			existing?.state === "PENDING" &&
			existing.nextRetryAt === null &&
			existing.attempt > 0
		) {
			const failedResult = await this.updateStepFailed(
				step.name,
				"Ambiguous effect was interrupted before local success evidence was persisted",
			);
			if (failedResult.status === "error") return Result.err(failedResult.error);
			return Result.err(
				new SagaEffectOutcomeUnknown({
					stepName: step.name,
					sagaId: this.sagaId,
					causeTag: "InterruptedEffect",
				}),
			);
		}

		if (existing?.state === "FAILED") {
			return Result.err(
				new SagaStepError({
					stepName: step.name,
					sagaId: this.sagaId,
					causeTag: "RetryExhausted",
					error: existing.lastError ?? "Persisted saga step failed",
				}),
			);
		}

		if (
			!this.retryCallbackExecution &&
			existing?.state === "PENDING" &&
			existing.nextRetryAt !== null &&
			existing.nextRetryAt > new Date().toISOString()
		) {
			const scheduled = await this.retryScheduler.scheduleRetry(
				Math.max(0, new Date(existing.nextRetryAt).getTime() - Date.now()),
			);
			if (scheduled.status === "error") return Result.err(scheduled.error);
			return Result.err(
				new SagaStepRetrying({
					stepName: step.name,
					sagaId: this.sagaId,
					attempt: existing.attempt,
					nextRetryAt: existing.nextRetryAt,
				}),
			);
		}

		const attempt = (existing?.attempt ?? 0) + 1;
		const pendingResult = await this.upsertStep(step.name, "PENDING", attempt);
		if (pendingResult.status === "error") return Result.err(pendingResult.error);

		this.stepStartTimes.set(step.name, Date.now());
		this.emit("step_started", { stepName: step.name });
		const executionResult = await this.executeWithTimeout(handler, options.timeout);
		const durationMs = Date.now() - (this.stepStartTimes.get(step.name) ?? Date.now());
		this.stepStartTimes.delete(step.name);

		if (executionResult.status === "error") {
			const error = executionResult.error;
			if (options.ambiguousEffect && isAmbiguousExternalEffectError(error)) {
				const failedResult = await this.updateStepFailed(step.name, String(error));
				if (failedResult.status === "error") return Result.err(failedResult.error);
				return Result.err(
					new SagaEffectOutcomeUnknown({
						stepName: step.name,
						sagaId: this.sagaId,
						causeTag: errorTag(error),
					}),
				);
			}

			if ((options.retryAllErrors || isRetryableError(error)) && attempt < options.maxRetries) {
				const exponentialDelay = Math.min(30000, 1000 * 2 ** attempt);
				const delay = getRetryDelayMs(error, exponentialDelay);
				const nextRetryAt = new Date(Date.now() + delay).toISOString();
				const retryEvidence = await this.updateStepRetry(
					step.name,
					attempt,
					nextRetryAt,
					String(error),
				);
				if (retryEvidence.status === "error") return Result.err(retryEvidence.error);

				const scheduleResult = await this.retryScheduler.scheduleRetry(delay);
				if (scheduleResult.status === "error") return Result.err(scheduleResult.error);

				return Result.err(
					new SagaStepRetrying({ stepName: step.name, sagaId: this.sagaId, attempt, nextRetryAt }),
				);
			}

			const failedResult = await this.updateStepFailed(step.name, String(error));
			if (failedResult.status === "error") return Result.err(failedResult.error);
			this.emit("step_failed", { stepName: step.name, error: String(error), durationMs });
			return Result.err(
				new SagaStepError({
					stepName: step.name,
					sagaId: this.sagaId,
					causeTag: errorTag(error),
					error: String(error),
				}),
			);
		}

		const successResult = await onFresh(executionResult.value);
		if (successResult.status === "error") return Result.err(successResult.error);

		this.emit("step_completed", { stepName: step.name, durationMs });
		logger.debug("Step executed successfully", { sagaId: this.sagaId, stepName: step.name });
		return successResult;
	}

	private encodePersisted<T>(
		codec: SagaCodec<T>,
		value: T,
		context: PersistedValueContext,
	): Result<string, SagaPersistedDataError> {
		const encoded = codec.encode(value);
		if (encoded.status === "error") {
			return Result.err(
				this.persistedDataError(codec, context.field, encoded.error.parseError, context.stepName),
			);
		}

		return stringifyPersistedJson({
			sagaId: this.sagaId,
			field: context.field,
			stepName: context.stepName,
			codecName: codec.name,
			value: encoded.value,
		});
	}

	private decodePersisted<T>(
		codec: SagaCodec<T>,
		json: string,
		context: PersistedValueContext,
	): Result<T, SagaPersistedDataError> {
		const parsed = parsePersistedJson({
			sagaId: this.sagaId,
			field: context.field,
			stepName: context.stepName,
			codecName: codec.name,
			json,
		});
		if (parsed.status === "error") return Result.err(parsed.error);

		const decoded = codec.parse(parsed.value);
		return decoded.status === "error"
			? Result.err(
					this.persistedDataError(codec, context.field, decoded.error.parseError, context.stepName),
				)
			: Result.ok(decoded.value);
	}

	private persistedDataError<T>(
		codec: SagaCodec<T>,
		field: SagaPersistedField,
		parseError: string,
		stepName?: string,
	): SagaPersistedDataError {
		return new SagaPersistedDataError({
			sagaId: this.sagaId,
			field,
			stepName,
			codecName: codec.name,
			parseError,
		});
	}

	private emit(
		event: SagaEvent,
		extra?: { readonly stepName?: string; readonly error?: string; readonly durationMs?: number },
	): void {
		if (!this.analytics || !this.sagaType) return;
		writeSagaLifecycleMetric(this.analytics, {
			sagaType: this.sagaType,
			sagaId: this.sagaId,
			event,
			...extra,
		});
	}

	private async getSagaDurationMs(): Promise<number> {
		const sagaResult = await this.getSaga();
		if (sagaResult.status === "error" || !sagaResult.value) return 0;
		return Date.now() - new Date(sagaResult.value.createdAt).getTime();
	}

	private async getStep(
		stepName: string,
	): Promise<Result<SagaStep | undefined, SagaRunnerDbError | SagaPersistedDataError>> {
		const loaded = await Result.tryPromise({
			try: () =>
				this.db.query.sagaSteps.findFirst({
					where: and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)),
				}),
			catch: (cause) => new SagaRunnerDbError({ operation: `getStep(${stepName})`, cause }),
		});
		if (loaded.status === "error" || loaded.value === undefined) return loaded;
		const parsed = SagaStepRowSchema.safeParse(loaded.value);
		return parsed.success
			? Result.ok(parsed.data)
			: Result.err(
					new SagaPersistedDataError({
						sagaId: this.sagaId,
						field: "step-row",
						stepName,
						codecName: "saga-step-row",
						parseError: z.prettifyError(parsed.error),
					}),
				);
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
					.values({ sagaId: this.sagaId, stepName, state, attempt })
					.onConflictDoUpdate({
						target: [sagaSteps.sagaId, sagaSteps.stepName],
						set: { state, attempt },
					});
			},
			catch: (cause) => new SagaRunnerDbError({ operation: `upsertStep(${stepName})`, cause }),
		});
	}

	private async updateStepSucceeded(
		stepName: string,
		resultJson: string,
		undoJson: string | null,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaSteps)
					.set({
						state: "SUCCEEDED",
						resultJson,
						undoJson,
						lastError: null,
						nextRetryAt: null,
					})
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) =>
				new SagaRunnerDbError({ operation: `updateStepSucceeded(${stepName})`, cause }),
		});
	}

	private async updateStepCompensated(stepName: string): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaSteps)
					.set({ state: "COMPENSATED", lastError: null, nextRetryAt: null })
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) =>
				new SagaRunnerDbError({ operation: `updateStepCompensated(${stepName})`, cause }),
		});
	}

	private async updateStepCompensationRetry(
		stepName: string,
		attempt: number,
		nextRetryAt: string,
		error: string,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaSteps)
					.set({ state: "COMPENSATION_PENDING", attempt, nextRetryAt, lastError: error })
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) =>
				new SagaRunnerDbError({ operation: `updateStepCompensationRetry(${stepName})`, cause }),
		});
	}

	private async updateSagaStatus(
		status: SagaRun["status"],
		error: string | null,
	): Promise<Result<void, SagaRunnerDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db
					.update(sagaRuns)
					.set({ status, error, updatedAt: new Date().toISOString() })
					.where(eq(sagaRuns.id, this.sagaId));
			},
			catch: (cause) => new SagaRunnerDbError({ operation: `updateSagaStatus(${status})`, cause }),
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
					.set({ state: "FAILED", lastError: error, nextRetryAt: null })
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
					.set({ state: "PENDING", attempt, nextRetryAt, lastError: error })
					.where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));
			},
			catch: (cause) => new SagaRunnerDbError({ operation: `updateStepRetry(${stepName})`, cause }),
		});
	}

	private async executeWithTimeout<T>(
		handler: (signal: AbortSignal) => Promise<T>,
		timeoutMs: number,
	): Promise<Result<T, Error>> {
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(`Saga step exceeded ${timeoutMs}ms`);
		}, timeoutMs);

		try {
			// Await settlement after abort so a timed-out mutation cannot commit behind a terminal transition.
			return Result.ok(await handler(controller.signal));
		} catch (error) {
			if (timedOut) {
				return Result.err(new Error(`Saga step timed out after ${timeoutMs}ms`));
			}
			return Result.err(error instanceof Error ? error : new Error(String(error)));
		} finally {
			clearTimeout(timeout);
		}
	}
}
