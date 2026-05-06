import { Result } from "better-result";

import { chatTextResponse } from "../types";

import type { CommandCounterStore } from "../types";
import type { ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for the skill issue counter.
 */
export class SkillIssueCommandHandler implements ComputedCommandHandler {
	constructor(private readonly counters: CommandCounterStore) {}

	/**
	 * Increment and report the skill issue counter.
	 *
	 * @returns A Result containing a chat response with the updated counter value.
	 */
	async handle() {
		const result = await this.counters.incrementCounter("skillissue");
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Couldn't count that skill issue right now."));
		}
		return Result.ok(chatTextResponse(`@dillon has ${result.value} SkillIssue so far`));
	}
}
