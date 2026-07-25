/**
 * HTTP query-string boundary helpers.
 */

/**
 * Read every query parameter without collapsing duplicates, allowing strict schemas
 * to reject unknown keys and repeated scalar options.
 */
export function readHttpQueryParameters(url: string): Record<string, string | readonly string[]> {
	const query: Record<string, string | string[]> = {};
	for (const [key, value] of new URL(url).searchParams) {
		const existing = query[key];
		query[key] =
			existing === undefined
				? value
				: Array.isArray(existing)
					? [...existing, value]
					: [existing, value];
	}
	return query;
}
