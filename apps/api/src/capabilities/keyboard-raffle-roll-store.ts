import { TaggedError } from "better-result";

import type { KeyboardRaffleRoll, RecordKeyboardRaffleRoll } from "../domain/keyboard-raffle";
import type { Result } from "better-result";

/** Expected failure while persisting or compensating a Keyboard Raffle Roll. */
export class KeyboardRaffleRollStoreError extends TaggedError("KeyboardRaffleRollStoreError")<{
	readonly operation: "recordRoll" | "deleteRoll";
	readonly failure: "transport" | "protocol" | "remote";
	readonly remoteErrorTag?: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: {
		operation: "recordRoll" | "deleteRoll";
		failure: "transport" | "protocol" | "remote";
		remoteErrorTag?: string;
		cause?: unknown;
	}) {
		super({ ...args, message: `Keyboard Raffle Roll store failed during ${args.operation}` });
	}
}

/** Persists Keyboard Raffle Rolls and supports saga compensation by Roll ID. */
export interface KeyboardRaffleRollStore {
	/** Records one idempotent Roll and returns derived record evidence. */
	recordRoll(
		input: RecordKeyboardRaffleRoll,
	): Promise<
		Result<
			Readonly<{ roll: KeyboardRaffleRoll; isNewRecord: boolean }>,
			KeyboardRaffleRollStoreError
		>
	>;
	/** Deletes one Roll during compensation; missing Rolls are treated as already deleted. */
	deleteRoll(rollId: string): Promise<Result<void, KeyboardRaffleRollStoreError>>;
}
