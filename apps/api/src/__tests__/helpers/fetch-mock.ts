import { vi } from "vite-plus/test";

interface InterceptOptions {
	readonly path: string | RegExp;
	readonly method?: string;
}

interface ReplyOptions {
	readonly headers?: HeadersInit;
}

interface PendingReply {
	readonly origin: string;
	readonly path: string | RegExp;
	readonly method: string;
	readonly status: number;
	readonly body?: BodyInit | null;
	readonly headers?: HeadersInit;
}

class PendingInterceptor {
	constructor(
		private readonly owner: FetchMock,
		private readonly origin: string,
		private readonly options: InterceptOptions,
	) {}

	reply(status: number, body?: BodyInit | null, options?: ReplyOptions): void {
		this.owner.add({
			origin: this.origin,
			path: this.options.path,
			method: (this.options.method ?? "GET").toUpperCase(),
			status,
			body,
			headers: options?.headers,
		});
	}
}

class OriginInterceptor {
	constructor(
		private readonly owner: FetchMock,
		private readonly origin: string,
	) {}

	intercept(options: InterceptOptions): PendingInterceptor {
		return new PendingInterceptor(this.owner, this.origin, options);
	}
}

/**
 * Minimal FIFO fetch interceptor for Workers tests that replaced the removed
 * Cloudflare `fetchMock` export in vitest-pool-workers 0.13+.
 */
export class FetchMock {
	private readonly pending: PendingReply[] = [];
	private installed = false;

	/** Installs a strict `globalThis.fetch` mock for the current test worker. */
	install(): void {
		if (this.installed) return;

		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => this.dispatch(input, init));
		this.installed = true;
	}

	/** Starts an interceptor chain for one request origin. */
	get(origin: string): OriginInterceptor {
		return new OriginInterceptor(this, origin);
	}

	/** Fails when a test registered requests that were never made. */
	assertNoPendingInterceptors(): void {
		if (this.pending.length === 0) return;

		const pending = this.pending
			.map(({ method, origin, path }) => `${method} ${origin}${String(path)}`)
			.join("\n");
		throw new Error(`Pending fetch interceptors:\n${pending}`);
	}

	/** Clears request expectations between tests. */
	reset(): void {
		this.pending.length = 0;
	}

	/** Registers a response for the next matching request. */
	add(reply: PendingReply): void {
		this.pending.push(reply);
	}

	private dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const path = `${url.pathname}${url.search}`;
		const index = this.pending.findIndex(
			(reply) =>
				reply.origin === url.origin &&
				reply.method === method &&
				(typeof reply.path === "string" ? reply.path === path : reply.path.test(path)),
		);

		if (index === -1) {
			return Promise.reject(new Error(`Unexpected fetch: ${method} ${url.href}`));
		}

		const [reply] = this.pending.splice(index, 1);
		if (reply === undefined) {
			return Promise.reject(new Error("Matched fetch interceptor disappeared"));
		}

		const body =
			reply.status === 204 || reply.status === 205 || reply.status === 304 ? null : reply.body;
		return Promise.resolve(
			new Response(body, {
				status: reply.status,
				headers: reply.headers,
			}),
		);
	}
}

/** Shared fetch interceptor installed by the test setup file. */
export const fetchMock = new FetchMock();
