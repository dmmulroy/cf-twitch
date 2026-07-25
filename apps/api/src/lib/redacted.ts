/** Credential wrapper whose string and JSON representations never reveal the wrapped secret. */
export class RedactedValue<T> {
	readonly #value: T;

	private constructor(value: T) {
		this.#value = value;
	}

	/** Wrap a credential at its input boundary. */
	static fromSensitiveValue<T>(value: T): RedactedValue<T> {
		return new RedactedValue(value);
	}

	/** Reveal a credential only to the adapter performing its final provider I/O. */
	unsafeUnwrapForFinalIo(): T {
		return this.#value;
	}

	/** Produce a stable redacted representation safe for diagnostics. */
	toString(): "[REDACTED]" {
		return "[REDACTED]";
	}

	/** Prevent credential disclosure during accidental JSON serialization. */
	toJSON(): "[REDACTED]" {
		return "[REDACTED]";
	}
}

/** Sensitive value retained in a redacted wrapper until final provider I/O. */
export type Redacted<T> = RedactedValue<T>;

/** Wrap a sensitive value at its input boundary. */
export function redactValue<T>(value: T): Redacted<T> {
	return RedactedValue.fromSensitiveValue(value);
}

/** Reveal a sensitive value only in the final I/O adapter that requires it. */
export function revealRedactedValue<T>(redacted: Redacted<T>): T {
	return redacted.unsafeUnwrapForFinalIo();
}
