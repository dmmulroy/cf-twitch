declare const redactedBrand: unique symbol;

/** Opaque wrapper that prevents credentials from appearing in JSON, string coercion, or object snapshots. */
export interface Redacted<T> {
	/** Stable redacted representation safe for diagnostics. */
	toString(): "[REDACTED]";
	/** Stable redacted JSON representation safe for diagnostics and snapshots. */
	toJSON(): "[REDACTED]";
	readonly [redactedBrand]: T;
}

const redactedValues = new WeakMap<object, unknown>();

/** Wrap a sensitive value at its input boundary. */
export function redactValue<T>(value: T): Redacted<T> {
	const wrapper = Object.freeze({
		toString: () => "[REDACTED]" as const,
		toJSON: () => "[REDACTED]" as const,
	});
	redactedValues.set(wrapper, value);
	// SAFETY: The unexported brand prevents callers from constructing Redacted<T>;
	// this factory records the corresponding T in redactedValues before branding.
	return wrapper as Redacted<T>;
}

/** Reveal a sensitive value only in the final I/O adapter that requires it. */
export function revealRedactedValue<T>(redacted: Redacted<T>): T {
	if (!redactedValues.has(redacted)) {
		throw new Error("Redacted value was not created by redactValue");
	}

	// SAFETY: Membership in redactedValues proves this wrapper was created by
	// redactValue<T>, which stores exactly the corresponding T value.
	return redactedValues.get(redacted) as T;
}
