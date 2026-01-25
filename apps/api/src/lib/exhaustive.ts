/**
 * Exhaustiveness utilities for discriminated unions and switch/if-else chains
 *
 * Adapted from @livestore/utils
 */

/**
 * Stringify a value for error messages, handling objects specially
 */
function valueToString(value: unknown): string {
	const str = String(value);
	if (str !== "[object Object]") return str;

	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return str;
	}
}

/**
 * Truncate a string to a maximum length
 */
function truncate(str: string, length: number): string {
	return str.length > length ? `${str.slice(0, length)}...` : str;
}

/**
 * Assert all cases in a discriminated union have been handled.
 * Use at the end of if-else chains or switch statements.
 *
 * @example
 * ```ts
 * type Command = "song" | "queue"
 *
 * function handle(cmd: Command) {
 *   if (cmd === "song") return handleSong()
 *   if (cmd === "queue") return handleQueue()
 *   return casesHandled(cmd) // TS error if case missing, throws at runtime
 * }
 * ```
 */
export function casesHandled(unexpectedCase: never): never {
	shouldNeverHappen(`Unhandled case: ${truncate(valueToString(unexpectedCase), 1000)}`);
}

/**
 * Mark code paths that should never be reached.
 * Throws with a descriptive message.
 *
 * @example
 * ```ts
 * const value = getOptionalValue()
 * if (!value) {
 *   return shouldNeverHappen("Value was unexpectedly missing")
 * }
 * ```
 */
export function shouldNeverHappen(msg?: string): never {
	throw new Error(`This should never happen${msg ? `: ${msg}` : ""}`);
}

/**
 * Placeholder for unimplemented code paths.
 * Throws with a descriptive message.
 *
 * @example
 * ```ts
 * function parseFormat(format: Format) {
 *   switch (format) {
 *     case "json": return parseJson
 *     case "xml": return notYetImplemented("XML parsing")
 *   }
 * }
 * ```
 */
export function notYetImplemented(msg?: string): never {
	throw new Error(`Not yet implemented${msg ? `: ${msg}` : ""}`);
}

/**
 * Assert a tagged union value has a specific tag, narrowing its type.
 * Throws if the tag doesn't match.
 *
 * @example
 * ```ts
 * type Result = { _tag: "ok"; value: number } | { _tag: "error"; message: string }
 * const result: Result = ...
 * const ok = assertTag(result, "ok") // Type is { _tag: "ok"; value: number }
 * ```
 */
export function assertTag<TObj extends { _tag: string }, TTag extends TObj["_tag"]>(
	obj: TObj,
	tag: TTag,
): Extract<TObj, { _tag: TTag }> {
	if (obj._tag !== tag) {
		throw new Error(`Expected tag "${tag}" but got "${obj._tag}"`);
	}

	return obj as Extract<TObj, { _tag: TTag }>;
}
