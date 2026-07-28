/** RPC stub shape exposed by Agent-based Durable Objects before their name is initialized. */
export type DurableObjectAgentStub = Readonly<{
	setName?: (name: string) => Promise<unknown>;
}>;

/** Initializes an Agent name before invoking behavior that reads or emits Agent state. */
export async function initializeDurableObjectAgentStub<T extends DurableObjectAgentStub>(
	stub: T,
	name: string,
): Promise<T> {
	if (stub.setName !== undefined) await stub.setName(name);
	return stub;
}
