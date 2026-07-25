/** Credential wrapper whose string and JSON representations never reveal the wrapped secret. */
export class RedactedValue<T> {
	readonly #value: T;

	private constructor(value: T) {
		this.#value = value;
	}

	/** Wraps a credential at its input boundary. */
	static fromSensitiveValue<T>(value: T): RedactedValue<T> {
		return new RedactedValue(value);
	}

	/** Reveals a credential only to the adapter performing its final provider I/O. */
	unsafeUnwrapForFinalIo(): T {
		return this.#value;
	}

	/** Produces a safe diagnostic representation. */
	toString(): string {
		return "[REDACTED]";
	}

	/** Prevents credential disclosure during accidental JSON serialization. */
	toJSON(): string {
		return "[REDACTED]";
	}
}
