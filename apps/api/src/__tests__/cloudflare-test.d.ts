/**
 * Type declarations for cloudflare:test module
 */

import type { Env } from "../index";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
