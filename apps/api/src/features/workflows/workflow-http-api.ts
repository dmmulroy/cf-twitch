import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { WorkflowError, WorkflowInput, WorkflowRunStatus } from "@cf-twitch/contracts/workflow";
/** Versioned workflow HTTP operations expose durable acceptance and safe status only. */
export class WorkflowHttpApi extends HttpApi.make("WorkflowHttpApi")
  .add(
    HttpApiGroup.make("workflow").add(
      HttpApiEndpoint.post("start", "/start", {
        payload: WorkflowInput,
        success: Schema.Void,
        error: WorkflowError,
      }),
      HttpApiEndpoint.get("getStatus", "/status", {
        success: Schema.OptionFromNullOr(WorkflowRunStatus),
        error: WorkflowError,
      }),
    ),
  )
  .prefix("/v1") {}
