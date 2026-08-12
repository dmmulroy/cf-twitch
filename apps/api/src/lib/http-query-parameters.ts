/**
 * HTTP query-string boundary helpers.
 */

/** Raw query parameter values grouped by their URL-encoded name. */
export interface HttpQueryParameters {
	[name: string]: string | readonly string[];
}

/**
 * Read every query parameter without collapsing duplicates, allowing strict schemas
 * to reject unknown keys and repeated scalar options.
 */
export function readHttpQueryParameters(url: string): HttpQueryParameters {
	const query: HttpQueryParameters = {};
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
