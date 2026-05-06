import { Result } from "better-result";

import { chatTextResponse } from "../types";

import type { Clock } from "../../clock";
import type { ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for current time responses.
 */
export class TimeCommandHandler implements ComputedCommandHandler {
	constructor(private readonly clock: Clock) {}

	/**
	 * Format and report the current Eastern time.
	 *
	 * @returns A Result containing a chat response with formatted current time.
	 */
	async handle() {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: "America/New_York",
			hour: "numeric",
			minute: "2-digit",
			second: "2-digit",
			hour12: true,
			timeZoneName: "short",
		});

		return Result.ok(chatTextResponse(`Current time is: ${formatter.format(this.clock.now())}`));
	}
}
