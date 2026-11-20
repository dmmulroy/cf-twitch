/**
 * Root entry point that Traits loads from the Git root, re-exporting the configuration in `tools/traits`.
 *
 * **Details**
 *
 * The configuration and the Claude subscription language model live in `tools/traits`.
 */
export { default } from "./tools/traits/traits-config.ts";
