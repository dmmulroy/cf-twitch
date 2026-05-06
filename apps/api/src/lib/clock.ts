import { Result, TaggedError } from "better-result";

const isoTimestampEvidence: unique symbol = Symbol("IsoTimestamp");

export type IsoTimestamp = string & { readonly [isoTimestampEvidence]: true };

export class InvalidIsoTimestampError extends TaggedError("InvalidIsoTimestampError")<{
	input: string;
	message: string;
}>() {
	constructor(input: string) {
		super({ input, message: `Invalid ISO timestamp: ${input}` });
	}
}

export function isoTimestampFromDate(date: Date): IsoTimestamp {
	return date.toISOString() as IsoTimestamp;
}

/**
 * Minimal wall-clock seam for code that needs injectable time.
 */
export interface Clock {
	now(): Date;
	nowIsoTimestamp(): IsoTimestamp;
	parseIsoTimestamp(input: string): Result<IsoTimestamp, InvalidIsoTimestampError>;
	resolveIsoTimestamp(input?: string): IsoTimestamp;
	isBefore(left: IsoTimestamp, right: IsoTimestamp): boolean;
}

/**
 * Production clock implementation backed by Date.
 */
export class SystemClock implements Clock {
	constructor(private readonly currentDate: () => Date = () => new Date()) {}

	now(): Date {
		return this.currentDate();
	}

	nowIsoTimestamp(): IsoTimestamp {
		return isoTimestampFromDate(this.now());
	}

	parseIsoTimestamp(input: string): Result<IsoTimestamp, InvalidIsoTimestampError> {
		const parsedMs = new Date(input).getTime();
		if (Number.isNaN(parsedMs)) {
			return Result.err(new InvalidIsoTimestampError(input));
		}

		return Result.ok(isoTimestampFromDate(new Date(parsedMs)));
	}

	resolveIsoTimestamp(input?: string): IsoTimestamp {
		if (input === undefined) {
			return this.nowIsoTimestamp();
		}

		const parsed = this.parseIsoTimestamp(input);
		if (parsed.status === "ok") {
			return parsed.value;
		}

		return this.nowIsoTimestamp();
	}

	isBefore(left: IsoTimestamp, right: IsoTimestamp): boolean {
		return new Date(left).getTime() < new Date(right).getTime();
	}
}
