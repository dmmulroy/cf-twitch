# Chat Commands System — Implementation Spec

**Status:** Ready for implementation  
**Effort:** L (1-2 days)  
**Date:** 2026-02-04

## Summary

Add chat command system with CommandsDO registry. Commands: `!achievements [user]`, `!dotfiles`, `!stats [user]`, `!keyboard`, `!socials`, `!today`, `!project`, `!update`, `!raffle-leaderboard`, `!commands`.

## Commands Overview

| Command                 | Type     | Permission | Description                          |
| ----------------------- | -------- | ---------- | ------------------------------------ |
| `!keyboard`             | static   | everyone   | Keyboard info + YT link              |
| `!socials`              | static   | everyone   | GH + X links                         |
| `!dotfiles`             | static   | everyone   | Dotfiles repo URL                    |
| `!today`                | dynamic  | everyone   | Current task (alias of project)      |
| `!project`              | dynamic  | everyone   | Current task (alias of today)        |
| `!update <cmd> <value>` | meta     | moderator  | Update dynamic commands              |
| `!achievements [user]`  | computed | everyone   | User's unlocked achievements         |
| `!stats [user]`         | computed | everyone   | User's song/achievement/raffle stats |
| `!raffle-leaderboard`   | computed | everyone   | Top raffle winners                   |
| `!commands`             | meta     | everyone   | List available commands              |

## Architecture

### New: CommandsDO

Single DO instance for command registry + values.

**Schema:**

```typescript
// commands table
commands: {
  name: text PK,           // "keyboard", "today", etc
  description: text,       // For !commands output
  category: text,          // "info" | "stats" | "meta" | "music"
  responseType: text,      // "static" | "dynamic" | "computed"
  permission: text,        // "everyone" | "moderator" | "broadcaster"
  enabled: boolean,
  createdAt: text,
}

// command_values table (static/dynamic only)
commandValues: {
  commandName: text PK FK,
  value: text,
  updatedAt: text,
  updatedBy: text | null,
}
```

**RPC Methods:**

```typescript
getCommand(name: string): Result<Command | null, CommandsDbError>
getAllCommands(): Result<Command[], CommandsDbError>
getCommandsByPermission(maxPerm: Permission): Result<Command[], CommandsDbError>
getCommandValue(name: string): Result<string | null, CommandsDbError>
setCommandValue(name: string, value: string, updatedBy: string): Result<void, CommandsDbError | CommandNotUpdateableError>
seedCommands(): Result<void, CommandsDbError>
```

### New: SongQueueDO method

```typescript
getUserRequestCount(userId: string): Result<number, SongQueueDbError>
```

### Permission Helper

```typescript
type Permission = "everyone" | "moderator" | "broadcaster";

function getUserPermission(badges: Badge[]): Permission {
	if (badges.some((b) => b.set_id === "broadcaster")) return "broadcaster";
	if (badges.some((b) => b.set_id === "moderator")) return "moderator";
	return "everyone";
}
```

## Seed Data

| name               | category | responseType | permission | value                                                                          |
| ------------------ | -------- | ------------ | ---------- | ------------------------------------------------------------------------------ | ----------------------- |
| keyboard           | info     | static       | everyone   | "SA Voyager with Choc White switches: https://youtube.com/watch?v=WfIfxaXC_Q4" |
| socials            | info     | static       | everyone   | "GitHub: github.com/dmmulroy                                                   | X: x.com/dillon_mulroy" |
| dotfiles           | info     | static       | everyone   | "https://github.com/dmmulroy/.dotfiles"                                        |
| today              | info     | dynamic      | everyone   | ""                                                                             |
| project            | info     | dynamic      | everyone   | ""                                                                             |
| achievements       | stats    | computed     | everyone   | -                                                                              |
| stats              | stats    | computed     | everyone   | -                                                                              |
| raffle-leaderboard | stats    | computed     | everyone   | -                                                                              |
| commands           | meta     | computed     | everyone   | -                                                                              |
| update             | meta     | computed     | moderator  | -                                                                              |
| song               | music    | computed     | everyone   | -                                                                              |
| queue              | music    | computed     | everyone   | -                                                                              |

## Response Formats

```
!keyboard → "SA Voyager with Choc White switches: https://youtube.com/watch?v=WfIfxaXC_Q4"

!socials → "GitHub: github.com/dmmulroy | X: x.com/dillon_mulroy"

!dotfiles → "https://github.com/dmmulroy/.dotfiles"

!today → "Working on: <value>" OR "No topic set for today"
!project → (same as !today)

!update today Building chat commands → "Updated !today"
!update keyboard ... → "!keyboard is not updateable"

!achievements → "@caller has unlocked 5 achievements: First Request, Streak Master, ..."
!achievements dmmulroy → "@dmmulroy has unlocked 5 achievements: ..."
(none) → "@user hasn't unlocked any achievements yet"

!stats → "@caller — Songs: 12 | Achievements: 5/20 | Raffles: 3 entered, 1 won"
!stats dmmulroy → "@dmmulroy — Songs: 12 | ..."

!raffle-leaderboard → "Raffle wins: 1. @alice (5) 2. @bob (3) 3. @charlie (2)"

!commands → "Commands: !keyboard !socials !dotfiles !today !achievements !stats !raffle-leaderboard !song !queue"
(mods) → "... | Mod: !update"
```

## Deliverables

| #   | Deliverable                                      | Effort | Depends    | Files                                                             |
| --- | ------------------------------------------------ | ------ | ---------- | ----------------------------------------------------------------- |
| D1  | CommandsDO schema + DO class                     | M      | -          | `durable-objects/commands-do.ts`, `schemas/commands-do.schema.ts` |
| D2  | SongQueueDO.getUserRequestCount()                | S      | -          | `durable-objects/song-queue-do.ts`                                |
| D3  | Permission helper                                | S      | -          | `lib/permissions.ts`                                              |
| D4  | Command parsing refactor                         | S      | -          | `routes/webhooks.ts`                                              |
| D5  | Static handlers (!keyboard, !socials, !dotfiles) | S      | D1, D4     | `routes/webhooks.ts`                                              |
| D6  | Dynamic handlers (!today, !project, !update)     | M      | D1, D3, D4 | `routes/webhooks.ts`                                              |
| D7  | Computed handlers (!achievements, !stats)        | M      | D1, D2, D4 | `routes/webhooks.ts`                                              |
| D8  | !raffle-leaderboard handler                      | S      | D1, D4     | `routes/webhooks.ts`                                              |
| D9  | !commands handler                                | S      | D1, D3, D4 | `routes/webhooks.ts`                                              |
| D10 | Migrate !song/!queue to registry                 | S      | D1         | `routes/webhooks.ts`                                              |
| D11 | Wrangler config + index exports                  | S      | D1         | `wrangler.jsonc`, `index.ts`                                      |
| D12 | Tests                                            | M      | D1-D11     | `__tests__/commands-do.test.ts`                                   |

## Key Files to Modify

- `apps/api/src/durable-objects/commands-do.ts` (new)
- `apps/api/src/durable-objects/schemas/commands-do.schema.ts` (new)
- `apps/api/src/durable-objects/song-queue-do.ts` (add method)
- `apps/api/src/lib/permissions.ts` (new)
- `apps/api/src/routes/webhooks.ts` (command handlers)
- `apps/api/src/index.ts` (export DO)
- `apps/api/wrangler.jsonc` (DO binding)
- `apps/api/src/lib/analytics.ts` (ChatCommandType union)

## Implementation Notes

### !today / !project Aliasing

Both commands read/write same `commandValues` row with `commandName = "today"`. Parse either command name → lookup "today" value.

### User Argument Parsing

```typescript
function parseCommandWithArg(text: string): { command: string; arg: string | null } {
	const parts = text.trim().split(/\s+/);
	const command = parts[0]?.slice(1).toLowerCase(); // remove !
	const arg = parts[1] ?? null;
	return { command, arg };
}
```

For `!achievements` and `!stats`: if arg provided, lookup that user; else use caller's displayName.

### Seed on First Access

`CommandsDO.seedCommands()` called on DO construction in `blockConcurrencyWhile`. Idempotent via `INSERT OR IGNORE`.

### Error Types

```typescript
class CommandsDbError extends TaggedError {
	readonly _tag = "CommandsDbError";
}
class CommandNotFoundError extends TaggedError {
	readonly _tag = "CommandNotFoundError";
}
class CommandNotUpdateableError extends TaggedError {
	readonly _tag = "CommandNotUpdateableError";
}
```

## Acceptance Criteria

- [ ] `!keyboard` responds with keyboard info + YT link
- [ ] `!socials` responds with GH + X links
- [ ] `!dotfiles` responds with repo URL
- [ ] `!today` and `!project` return same value
- [ ] `!today` shows "No topic set" when empty
- [ ] `!update today <value>` works for broadcaster/mod
- [ ] `!update today <value>` silently ignored for non-mods
- [ ] `!update keyboard <value>` returns "not updateable"
- [ ] `!achievements` shows caller's achievements
- [ ] `!achievements <user>` shows that user's achievements
- [ ] `!stats` shows caller's song/achievement/raffle stats
- [ ] `!stats <user>` shows that user's stats
- [ ] `!raffle-leaderboard` shows top winners by wins
- [ ] `!commands` lists commands; mods see `!update`
- [ ] Existing `!song` and `!queue` continue working

## Verification

1. Deploy locally: `pnpm dev`
2. Send test EventSub payloads via curl or Twitch CLI
3. Verify responses in chat
4. Run `pnpm test` for unit tests
5. `pnpm typecheck` passes

## Trade-offs

| Chose                    | Over            | Because                              |
| ------------------------ | --------------- | ------------------------------------ |
| All values in CommandsDO | Hardcoded       | Flexibility to change without deploy |
| Trust EventSub badges    | API lookup      | Lower latency                        |
| No cooldowns             | Rate limiting   | User preference                      |
| Alias via shared key     | Separate values | Simpler, always in sync              |

## Risks

| Risk                     | Mitigation                      |
| ------------------------ | ------------------------------- |
| Badge data missing       | Default to "everyone"           |
| DO not seeded            | Seed in constructor, idempotent |
| User not found for stats | Return "no data for @user"      |
