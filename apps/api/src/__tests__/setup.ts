import { exports } from "cloudflare:workers";
import { afterEach, beforeAll } from "vite-plus/test";

import { fetchMock } from "./helpers/fetch-mock";

beforeAll(async () => {
	fetchMock.install();
	await exports.default.fetch("http://warmup/");
}, 30_000);

afterEach(() => {
	try {
		fetchMock.assertNoPendingInterceptors();
	} finally {
		fetchMock.reset();
	}
});
