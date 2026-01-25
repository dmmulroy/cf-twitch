/**
 * Warm Workflow Pool Utilities
 *
 * Helpers for implementing the warm workflow pool pattern where workflows
 * start waiting at step.waitForEvent("activate") until activated with payload.
 */

import { getStub } from "./durable-objects";
import { logger } from "./logger";

import type { WorkflowType } from "../durable-objects/schemas/workflow-pool-do.schema";
import type { WorkflowStep } from "cloudflare:workers";

/**
 * Event type for workflow activation.
 * Warm instances wait for this event to receive their actual payload.
 */
export const ACTIVATE_EVENT_TYPE = "activate";

/**
 * Timeout for warm instances waiting for activation.
 * After this, the instance will throw and should be cleaned up.
 */
export const WARM_TIMEOUT = "24 hours";

/**
 * Payload structure for the activate event
 */
export interface ActivateEventPayload<T> {
	params: T;
}

/**
 * Wait for activation event and return the payload.
 * This should be the first step in a warm-capable workflow.
 *
 * @param step The workflow step
 * @param initialPayload The initial payload (undefined for warm instances, T for cold)
 * @returns The actual workflow params (from event if warm, from initial if cold)
 */
export async function waitForActivation<T>(
	step: WorkflowStep,
	initialPayload: T | { __warm__: true },
): Promise<T> {
	if (
		typeof initialPayload === "object" &&
		initialPayload !== null &&
		initialPayload !== undefined &&
		"__warm__" in initialPayload
	) {
		// Warm instance - wait for activation event
		const event = await step.waitForEvent("wait-for-activation", {
			type: ACTIVATE_EVENT_TYPE,
			timeout: WARM_TIMEOUT,
		});

		// Cast is safe - we control both sender (triggerWarmWorkflow) and receiver
		return (event.payload as ActivateEventPayload<T>).params;
	}

	return initialPayload;
}

/**
 * Options for triggering a workflow
 */
export interface TriggerWorkflowOptions<T> {
	/** The workflow binding */
	workflow: Workflow<T | undefined>;
	/** The workflow type for pool lookup */
	workflowType: WorkflowType;
	/** ID for the workflow instance (for idempotency) */
	instanceId: string;
	/** The payload to pass to the workflow */
	params: T;
}

/**
 * Trigger a workflow using warm pool if available, falling back to cold start.
 *
 * 1. Ask pool DO for a warm instance
 * 2. If available: sendEvent to activate it with params
 * 3. If not: cold create() with params directly
 * 4. Async replenish pool after consuming warm instance
 *
 * @returns true if workflow was started successfully
 */
export async function triggerWarmWorkflow<T>(options: TriggerWorkflowOptions<T>): Promise<boolean> {
	const { workflow, workflowType, instanceId, params } = options;
	const poolStub = getStub("WORKFLOW_POOL_DO");

	// Try to get a warm instance from the pool
	const warmResult = await poolStub.getWarmInstance(workflowType);

	if (warmResult.status === "error") {
		logger.error("Failed to get warm instance from pool", {
			workflowType,
			error: warmResult.error.message,
		});
		// Fall through to cold start
	}

	const warmInstanceId = warmResult.status === "ok" ? warmResult.value : null;

	if (warmInstanceId) {
		// Activate warm instance via sendEvent
		try {
			const instance = await workflow.get(warmInstanceId);
			await instance.sendEvent({
				type: ACTIVATE_EVENT_TYPE,
				payload: { params } satisfies ActivateEventPayload<T>,
			});

			logger.info("Activated warm workflow instance", {
				workflowType,
				warmInstanceId,
				newInstanceId: instanceId,
			});

			// Async replenish pool (fire and forget)
			void (async () => {
				const replenishResult = await poolStub.replenish(workflowType);
				if (replenishResult.status === "error") {
					logger.error("Failed to replenish workflow pool", {
						workflowType,
						error: replenishResult.error.message,
					});
				}
			})();

			return true;
		} catch (error) {
			// Warm instance may have timed out or failed - fall through to cold start
			logger.warn("Failed to activate warm instance, falling back to cold start", {
				workflowType,
				warmInstanceId,
				error: error instanceof Error ? error.message : String(error),
			});

			// Remove the failed instance from pool tracking
			void poolStub.removeInstance(warmInstanceId);
		}
	}

	// Cold start fallback
	try {
		await workflow.create({ id: instanceId, params });
		logger.info("Cold started workflow", { workflowType, instanceId });
		return true;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Handle idempotency - instance already exists
		if (errorMessage.includes("already exists") || errorMessage.includes("instance ID")) {
			logger.info("Workflow instance already exists (idempotent)", {
				workflowType,
				instanceId,
			});
			return true;
		}

		logger.error("Failed to start workflow", {
			workflowType,
			instanceId,
			error: errorMessage,
		});
		return false;
	}
}
