# Workflows

Cloudflare Workflows with saga rollback pattern. See root AGENTS.md for conventions.

## Files

| File                 | Binding              | Purpose                    |
| -------------------- | -------------------- | -------------------------- |
| `song-request.ts`    | `SONG_REQUEST_WF`    | Spotify song queue request |
| `chat-command.ts`    | `CHAT_COMMAND_WF`    | !song, !queue commands     |
| `keyboard-raffle.ts` | `KEYBOARD_RAFFLE_WF` | Keyboard raffle redemption |

## Pattern

All workflows support warm pool activation:

```typescript
export class MyWorkflow extends WorkflowEntrypoint<Env, Params | undefined> {
  async run(event: WorkflowEvent<Params | undefined>, step: WorkflowStep) {
    // Support warm pool
    const params = await waitForActivation<Params>(step, event.payload);

    // Use rollback context for saga pattern
    const rollbackContext = createRollbackContext<RollbackStep>();

    try {
      // Step 1: Do thing (rollbackable)
      await step.do("step-1", async () => {
        const result = await doThing(params);
        rollbackContext.addStep({ type: "step-1", data: result });
        return result;
      });

      // POINT OF NO RETURN
      await step.do("fulfill-redemption", ...);

      // Steps after fulfill cannot be rolled back
    } catch (error) {
      await rollbackContext.rollback(this.env);
      throw error;
    }
  }
}
```

## SongRequestWorkflow

1. Parse Spotify URL
2. Get track info from Spotify
3. Persist in SongQueueDO (rollbackable)
4. Add to Spotify queue (rollbackable via skip-if-playing)
5. Write history
6. **Fulfill redemption** (point of no return)
7. Send chat confirmation

Refunds redemption on error before fulfill.

## KeyboardRaffleWorkflow

1. Generate winning number
2. Generate user roll
3. Record in KeyboardRaffleDO (rollbackable)
4. **Fulfill redemption**
5. Send chat result

## ChatCommandWorkflow

Simple command handling:

1. Parse command (!song, !queue)
2. Handle based on type
3. Send response to chat

No rollback needed - read-only operations.

## Warm Pool

Workflows started with `undefined` payload wait at `waitForActivation()`. The `WorkflowPoolDO` maintains a pool of 3 warm instances per workflow type. Use `triggerWarmWorkflow()` to activate.
