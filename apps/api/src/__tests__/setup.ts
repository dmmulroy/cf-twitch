/**
 * Global test setup - activates fetchMock and disables network
 *
 * NOTE: Tests that call code using getStub() are skipped because getStub()
 * imports global env from cloudflare:workers which isn't available in vitest.
 * The proper fix is refactoring getStub() to accept env as parameter.
 */

import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});
