import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { WorkflowExecution } from "./workflow-execution.ts";
import { WorkflowHttpApi } from "./workflow-http-api.ts";

/** HTTP workflow handlers share the same serialized execution service as native alarms. */
export const workflowHttpHandlersLayer = HttpApiBuilder.group(
  WorkflowHttpApi,
  "workflow",
  (handlers) =>
    Effect.gen(function* () {
      const execution = yield* WorkflowExecution;

      return handlers
        .handle("start", ({ payload }) => execution.start(payload))
        .handle("getStatus", () => execution.getStatus());
    }),
);
