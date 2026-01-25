/**
 * WorkflowPoolDO - Manages pools of pre-warmed workflow instances
 *
 * Maintains a pool of 3 warm instances per workflow type to avoid cold starts.
 * Warm instances wait at step.waitForEvent("activate") until activated via sendEvent.
 *
 * Pool management:
 * - On init: Create missing instances to reach pool size
 * - On getWarmInstance: Return and remove one instance from pool
 * - On replenish: Create a new warm instance to replace the consumed one
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/workflow-pool-do/migrations";
import { type StreamLifecycleHandler, WorkflowPoolError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	POOL_SIZE,
	WORKFLOW_TYPES,
	type WorkflowType,
	warmInstances,
} from "./schemas/workflow-pool-do.schema";

import type { Env } from "../index";

/**
 * Map workflow type to its binding key in Env
 */
const WORKFLOW_BINDINGS: Record<WorkflowType, keyof Env> = {
	"song-request": "SONG_REQUEST_WF",
	"chat-command": "CHAT_COMMAND_WF",
	"keyboard-raffle": "KEYBOARD_RAFFLE_WF",
};

export class WorkflowPoolDO
	extends DurableObject<Env>
	implements StreamLifecycleHandler<WorkflowPoolError>
{
	private db;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema: { warmInstances } });

		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			await this.initializePools();
		});
	}

	// =========================================================================
	// StreamLifecycleHandler implementation
	// =========================================================================

	/**
	 * Called when stream goes online. Fill all pools to target size.
	 */
	async onStreamOnline(): Promise<Result<void, WorkflowPoolError>> {
		logger.info("WorkflowPoolDO: stream online, warming pools");

		return Result.tryPromise({
			try: async () => {
				await this.initializePools();
			},
			catch: (cause) =>
				new WorkflowPoolError({
					operation: "onStreamOnline",
					workflowType: "all",
					message: `Failed to warm pools on stream online: ${String(cause)}`,
				}),
		});
	}

	/**
	 * Called when stream goes offline. No-op since paused workflows are free.
	 * Warm instances waiting at waitForEvent hibernate with no resource cost.
	 */
	async onStreamOffline(): Promise<Result<void, WorkflowPoolError>> {
		logger.debug("WorkflowPoolDO: stream offline, keeping warm pools (hibernated = free)");
		return Result.ok(undefined);
	}

	/**
	 * Initialize pools for all workflow types to reach target size.
	 * Called on DO init and can be called manually to top up pools.
	 */
	private async initializePools(): Promise<void> {
		for (const workflowType of WORKFLOW_TYPES) {
			const currentCount = await this.getPoolCount(workflowType);
			const needed = POOL_SIZE - currentCount;

			if (needed > 0) {
				logger.info("Initializing workflow pool", {
					workflowType,
					currentCount,
					needed,
				});

				for (let i = 0; i < needed; i++) {
					await this.createWarmInstance(workflowType);
				}
			}
		}
	}

	/**
	 * Get current pool count for a workflow type.
	 */
	private async getPoolCount(workflowType: WorkflowType): Promise<number> {
		const result = await this.db
			.select({ count: count() })
			.from(warmInstances)
			.where(eq(warmInstances.workflowType, workflowType));

		return result[0]?.count ?? 0;
	}

	/**
	 * Create a new warm workflow instance that waits for activation.
	 * The workflow will call step.waitForEvent("activate") as its first step.
	 */
	private async createWarmInstance(workflowType: WorkflowType): Promise<string | null> {
		const bindingKey = WORKFLOW_BINDINGS[workflowType];
		const workflow = this.env[bindingKey] as Workflow;

		const instanceId = `warm-${workflowType}-${crypto.randomUUID()}`;

		try {
			await workflow.create({ id: instanceId, params: { __warm__: true } });

			await this.db.insert(warmInstances).values({
				instanceId,
				workflowType,
				createdAt: new Date().toISOString(),
			});

			logger.debug("Created warm workflow instance", { workflowType, instanceId });
			return instanceId;
		} catch (error) {
			logger.error("Failed to create warm workflow instance", {
				workflowType,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Get a warm instance from the pool. Returns null if pool is empty.
	 * Caller is responsible for calling replenish() after use.
	 */
	async getWarmInstance(
		workflowType: WorkflowType,
	): Promise<Result<string | null, WorkflowPoolError>> {
		return Result.tryPromise({
			try: async () => {
				const instance = await this.db.query.warmInstances.findFirst({
					where: eq(warmInstances.workflowType, workflowType),
				});

				if (!instance) {
					logger.debug("No warm instances available", { workflowType });
					return null;
				}

				await this.db
					.delete(warmInstances)
					.where(
						and(
							eq(warmInstances.instanceId, instance.instanceId),
							eq(warmInstances.workflowType, workflowType),
						),
					);

				logger.info("Consumed warm instance from pool", {
					workflowType,
					instanceId: instance.instanceId,
				});

				return instance.instanceId;
			},
			catch: (cause) =>
				new WorkflowPoolError({
					operation: "getWarmInstance",
					workflowType,
					message: `Failed to get warm instance: ${String(cause)}`,
				}),
		});
	}

	/**
	 * Replenish the pool for a workflow type.
	 * Should be called after consuming a warm instance.
	 */
	async replenish(workflowType: WorkflowType): Promise<Result<void, WorkflowPoolError>> {
		return Result.tryPromise({
			try: async () => {
				const currentCount = await this.getPoolCount(workflowType);

				if (currentCount < POOL_SIZE) {
					await this.createWarmInstance(workflowType);
					logger.debug("Replenished workflow pool", { workflowType });
				}
			},
			catch: (cause) =>
				new WorkflowPoolError({
					operation: "replenish",
					workflowType,
					message: `Failed to replenish pool: ${String(cause)}`,
				}),
		});
	}

	/**
	 * Remove a specific instance from the pool (e.g., if it timed out or failed).
	 */
	async removeInstance(instanceId: string): Promise<Result<void, WorkflowPoolError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db.delete(warmInstances).where(eq(warmInstances.instanceId, instanceId));
				logger.debug("Removed instance from pool", { instanceId });
			},
			catch: (cause) =>
				new WorkflowPoolError({
					operation: "removeInstance",
					workflowType: "unknown" as WorkflowType,
					message: `Failed to remove instance: ${String(cause)}`,
				}),
		});
	}

	/**
	 * Get pool status for debugging/monitoring.
	 */
	async getPoolStatus(): Promise<Result<Record<WorkflowType, number>, WorkflowPoolError>> {
		return Result.tryPromise({
			try: async () => {
				const status = {} as Record<WorkflowType, number>;

				for (const workflowType of WORKFLOW_TYPES) {
					status[workflowType] = await this.getPoolCount(workflowType);
				}

				return status;
			},
			catch: (cause) =>
				new WorkflowPoolError({
					operation: "getPoolStatus",
					workflowType: "unknown" as WorkflowType,
					message: `Failed to get pool status: ${String(cause)}`,
				}),
		});
	}

	/**
	 * Force refill all pools to target size.
	 * Useful for recovering from errors or after deployment.
	 */
	async refillPools(): Promise<Result<void, WorkflowPoolError>> {
		return Result.tryPromise({
			try: async () => {
				await this.initializePools();
				logger.info("Refilled all workflow pools");
			},
			catch: (cause) =>
				new WorkflowPoolError({
					operation: "refillPools",
					workflowType: "unknown" as WorkflowType,
					message: `Failed to refill pools: ${String(cause)}`,
				}),
		});
	}
}
