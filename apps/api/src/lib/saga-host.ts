import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/saga-do/migrations";
import * as sagaSchema from "../durable-objects/schemas/saga.schema";
import { type SagaStatus } from "../durable-objects/schemas/saga.schema";
import { type SagaType } from "./analytics";
import { type SagaCodec } from "./codecs";
import { rpc } from "./durable-objects";
import {
	SagaAlreadyExistsError,
	SagaInputParseError,
	SagaNotFoundError,
	SagaPersistedDataError,
	SagaScheduleError,
} from "./errors";
import { logger } from "./logger";
import { SagaRunner, SagaRunnerDbError } from "./saga-runner";

import type { Env } from "../index";

const RETRY_CALLBACK = "retrySagaTick" as const;
const RETRY_SCHEDULE_OPTIONS = {
	idempotent: true,
	retry: { maxAttempts: 1 },
} as const;

interface SagaHostState {
	readonly retryScheduleId: string | null;
	readonly retryDueAt: string | null;
}

/** Stable status projection shared by saga Durable Objects. */
export interface SagaHostStatus {
	readonly sagaId: string;
	readonly status: SagaStatus;
	readonly fulfilledAt: string | null;
	readonly error: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Concrete saga metadata required by the shared host lifecycle. */
export interface SagaHostDefinition<P> {
	readonly sagaType: SagaType;
	readonly paramsCodec: SagaCodec<P>;
}

/** Infrastructure failures owned by the shared saga host lifecycle. */
export type SagaHostLifecycleError = SagaRunnerDbError | SagaPersistedDataError | SagaScheduleError;

/** Expected failures that can be returned from the public saga start RPC. */
export type SagaHostStartError<E> = SagaInputParseError | SagaHostLifecycleError | E;

/**
 * Owns the technical Durable Object lifecycle around one typed saga.
 *
 * Concrete sagas provide only their definition and business orchestration;
 * SQLite initialization, RPC parsing, replay, status, and runtime scheduling
 * remain hidden here.
 */
export abstract class SagaHost<P, E> extends Agent<Env, SagaHostState> {
	private readonly db: ReturnType<typeof drizzle<typeof sagaSchema>>;
	private runner: SagaRunner<P> | null = null;

	/** Empty retry coordination state; SQLite remains the lifecycle source of truth. */
	initialState: SagaHostState = {
		retryScheduleId: null,
		retryDueAt: null,
	};

	/** Creates a host over the Durable Object's SQLite storage and runtime environment. */
	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema: sagaSchema });
	}

	/** The parameter codec and analytics identity supplied by a concrete saga. */
	protected abstract get sagaDefinition(): SagaHostDefinition<P>;

	/** Runs concrete business orchestration with canonical persisted parameters. */
	protected abstract runSaga(params: P, runner: SagaRunner<P>): Promise<Result<void, E>>;

	/** Migrates saga storage and restores runtime retry coordination from SQLite. */
	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);

			const restoration = await this.restoreRetrySchedule();
			if (restoration.status === "error") {
				logger.error("Saga retry restoration failed", {
					event: "saga_host.retry_restoration.failed",
					saga_id: this.sagaId,
					saga_type: this.sagaDefinition.sagaType,
					error_tag: restoration.error._tag,
					operation: SagaScheduleError.is(restoration.error) ? restoration.error.operation : "read",
				});
			}
		});
	}

	/** Parses, initializes, or idempotently resumes a saga from original parameters. */
	@rpc
	async start(input: unknown): Promise<Result<void, SagaHostStartError<E>>> {
		const parsed = this.sagaDefinition.paramsCodec.parse(input);
		if (parsed.status === "error") {
			logger.info("Saga input rejected", {
				event: "saga_host.input.rejected",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
				codec_name: this.sagaDefinition.paramsCodec.name,
			});
			return Result.err(
				new SagaInputParseError({
					codecName: this.sagaDefinition.paramsCodec.name,
					parseError: parsed.error.parseError,
				}),
			);
		}

		const initialized = await this.getRunner().initSaga(parsed.value);
		if (initialized.status === "error" && !SagaAlreadyExistsError.is(initialized.error)) {
			return Result.err(initialized.error);
		}

		if (initialized.status === "error") {
			logger.info("Saga start resumed existing run", {
				event: "saga_host.start.resumed",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
			});
		}

		return this.resumeRunningSaga("start");
	}

	/** Returns the shared caller-facing status projection for this saga. */
	@rpc
	async getStatus(): Promise<Result<SagaHostStatus | null, SagaRunnerDbError>> {
		const saga = await this.getRunner().getSaga();
		if (saga.status === "error") return Result.err(saga.error);
		if (!saga.value) return Result.ok(null);

		return Result.ok({
			sagaId: saga.value.id,
			status: saga.value.status,
			fulfilledAt: saga.value.fulfilledAt,
			error: saga.value.error,
			createdAt: saga.value.createdAt,
			updatedAt: saga.value.updatedAt,
		});
	}

	/** Runtime-visible callback that safely resumes a running persisted saga. */
	async retrySagaTick(scheduledFor?: string): Promise<void> {
		if (scheduledFor !== undefined && this.state.retryDueAt !== scheduledFor) {
			logger.info("Stale saga retry callback skipped", {
				event: "saga_host.retry_callback.skipped",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
				reason: "stale-schedule",
			});
			return;
		}

		this.clearRetryCoordinationState();
		logger.info("Saga retry callback triggered", {
			event: "saga_host.retry_callback.triggered",
			saga_id: this.sagaId,
			saga_type: this.sagaDefinition.sagaType,
		});

		const resumed = await this.resumeRunningSaga("scheduled-callback");
		if (resumed.status === "error") {
			logger.error("Saga retry callback failed", {
				event: "saga_host.retry_callback.failed",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
				error_tag: errorTag(resumed.error),
			});
		}
	}

	private get sagaId(): string {
		return this.ctx.id.toString();
	}

	private getRunner(): SagaRunner<P> {
		if (this.runner === null) {
			this.runner = new SagaRunner({
				sagaId: this.sagaId,
				db: this.db,
				paramsCodec: this.sagaDefinition.paramsCodec,
				retryScheduler: {
					scheduleRetry: (delayMs) => this.scheduleRetry(delayMs),
				},
				analytics: this.env.ANALYTICS,
				sagaType: this.sagaDefinition.sagaType,
			});
		}

		return this.runner;
	}

	private async resumeRunningSaga(
		trigger: "start" | "scheduled-callback",
	): Promise<Result<void, SagaHostLifecycleError | E>> {
		const runner = this.getRunner();
		const saga = await runner.getSaga();
		if (saga.status === "error") return Result.err(saga.error);

		if (!saga.value) {
			logger.info("Saga resume skipped because the run is missing", {
				event: "saga_host.resume.skipped",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
				trigger,
				reason: "missing",
			});
			return this.clearRetrySchedule();
		}

		if (saga.value.status !== "RUNNING") {
			logger.info("Saga resume skipped because the run is not running", {
				event: "saga_host.resume.skipped",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
				trigger,
				reason: "not-running",
				saga_status: saga.value.status,
			});
			return this.clearRetrySchedule();
		}

		const params = await runner.getParams();
		if (params.status === "error") {
			if (SagaNotFoundError.is(params.error)) return this.clearRetrySchedule();
			return Result.err(params.error);
		}

		const execution = await this.runSaga(params.value, runner);
		if (execution.status === "error") return Result.err(execution.error);
		return this.clearRetrySchedule();
	}

	private async restoreRetrySchedule(): Promise<
		Result<void, SagaRunnerDbError | SagaScheduleError>
	> {
		const runner = this.getRunner();
		const saga = await runner.getSaga();
		if (saga.status === "error") return Result.err(saga.error);

		if (!saga.value || saga.value.status !== "RUNNING") {
			return this.clearRetrySchedule();
		}

		const pending = await runner.getNextRetryStep();
		if (pending.status === "error") return Result.err(pending.error);
		if (!pending.value?.nextRetryAt) {
			return this.clearRetrySchedule();
		}

		const coordinated = Result.try({
			try: () =>
				this.state.retryScheduleId === null
					? undefined
					: this.getSchedule(this.state.retryScheduleId),
			catch: (cause) =>
				new SagaScheduleError({
					sagaId: this.sagaId,
					operation: "inspect",
					message: "Saga retry schedule inspection failed",
					cause,
				}),
		});
		if (coordinated.status === "error") return Result.err(coordinated.error);

		if (
			coordinated.value !== undefined &&
			this.state.retryDueAt === pending.value.nextRetryAt &&
			coordinated.value.type === "scheduled" &&
			coordinated.value.callback === RETRY_CALLBACK &&
			coordinated.value.payload === pending.value.nextRetryAt &&
			coordinated.value.time === Math.floor(new Date(pending.value.nextRetryAt).getTime() / 1000)
		) {
			logger.info("Saga retry schedule retained", {
				event: "saga_host.retry_schedule.retained",
				saga_id: this.sagaId,
				saga_type: this.sagaDefinition.sagaType,
				retry_due_at: pending.value.nextRetryAt,
			});
			return Result.ok();
		}

		return this.scheduleRetryAt(pending.value.nextRetryAt);
	}

	private async scheduleRetry(_delayMs: number): Promise<Result<void, SagaScheduleError>> {
		const pending = await this.getRunner().getNextRetryStep();
		if (pending.status === "error") {
			return Result.err(
				new SagaScheduleError({
					sagaId: this.sagaId,
					operation: "schedule",
					message: "Persisted saga retry evidence could not be read",
				}),
			);
		}
		if (!pending.value?.nextRetryAt) {
			return Result.err(
				new SagaScheduleError({
					sagaId: this.sagaId,
					operation: "schedule",
					message: "Persisted saga retry evidence is missing",
				}),
			);
		}

		return this.scheduleRetryAt(pending.value.nextRetryAt);
	}

	private async scheduleRetryAt(whenIso: string): Promise<Result<void, SagaScheduleError>> {
		const cleared = await this.clearRetrySchedule();
		if (cleared.status === "error") return cleared;

		const scheduled = await Result.tryPromise({
			try: () => this.schedule(new Date(whenIso), RETRY_CALLBACK, whenIso, RETRY_SCHEDULE_OPTIONS),
			catch: () =>
				new SagaScheduleError({
					sagaId: this.sagaId,
					operation: "schedule",
					message: "Saga retry schedule creation failed",
				}),
		});
		if (scheduled.status === "error") return Result.err(scheduled.error);

		this.setState({
			...this.state,
			retryScheduleId: scheduled.value.id,
			retryDueAt: whenIso,
		});
		logger.info("Saga retry schedule coordinated", {
			event: "saga_host.retry_schedule.coordinated",
			saga_id: this.sagaId,
			saga_type: this.sagaDefinition.sagaType,
			retry_due_at: whenIso,
		});
		return Result.ok();
	}

	private async clearRetrySchedule(): Promise<Result<void, SagaScheduleError>> {
		const canceled = await Result.tryPromise({
			try: async () => {
				const scheduleIds = new Set(
					this.getSchedules()
						.filter((schedule) => schedule.callback === RETRY_CALLBACK)
						.map((schedule) => schedule.id),
				);
				if (this.state.retryScheduleId !== null) {
					scheduleIds.add(this.state.retryScheduleId);
				}

				for (const scheduleId of scheduleIds) {
					await this.cancelSchedule(scheduleId);
				}
			},
			catch: () =>
				new SagaScheduleError({
					sagaId: this.sagaId,
					operation: "cancel",
					message: "Saga retry schedule cancellation failed",
				}),
		});
		if (canceled.status === "error") return Result.err(canceled.error);

		this.clearRetryCoordinationState();
		return Result.ok();
	}

	private clearRetryCoordinationState(): void {
		if (this.state.retryScheduleId === null && this.state.retryDueAt === null) return;
		this.setState({
			...this.state,
			retryScheduleId: null,
			retryDueAt: null,
		});
	}
}

function errorTag(error: unknown): string {
	if (typeof error !== "object" || error === null || !("_tag" in error)) return "UnknownError";
	return typeof error._tag === "string" ? error._tag : "UnknownError";
}
