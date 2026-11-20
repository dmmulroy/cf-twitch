import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Config, Layer, Option } from "effect";
import type { TraitsConfig } from "traits";

import { claudeSubscriptionLanguageModelLayer } from "./claude-subscription-language-model.ts";

const typeSafeClientLayer = TypeSafeClient.layerConfig({
  apiKey: Config.Redacted("TYPESAFE_API_KEY"),
});

/**
 * Traits configuration that checks code with TypeSafe Jev and drafts traits with Claude Opus 5.5
 * through the Claude Code CLI on your Claude subscription.
 *
 * **Gotchas**
 *
 * Needs `TYPESAFE_API_KEY` (the root `.env` or the MCP process environment) and a Claude Code
 * login (`claude auth login`). Traits fails to start without the key.
 */
export default {
  /**
   * Generated lockfile and vendored anti-slop sources, which are not project-owned.
   *
   * **Gotchas**
   *
   * Traits 0.5.15 resolves `check_traits` include patterns to absolute paths but matches these
   * excludes as relative paths, so they currently exclude nothing; leave vendored paths out of
   * `include`.
   */
  excludes: ["pnpm-lock.yaml", "tools/oxlint/anti-slop/**", ".agents/skills/install-anti-slop/**"],
  /** TypeSafe Jev, which classifies source against traits; authenticates with `TYPESAFE_API_KEY`. */
  layerDecisionModel: TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
    Layer.provide(typeSafeClientLayer),
  ),
  /**
   * Claude Opus 5.5 at medium effort, which drafts and revises traits; runs `claude -p` on the
   * Claude subscription rather than an API key.
   */
  layerLanguageModel: claudeSubscriptionLanguageModelLayer({
    model: "claude-opus-5-5",
    effort: Option.some("medium"),
    command: Option.none(),
  }),
} satisfies TraitsConfig;
