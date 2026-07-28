import { z } from "zod";

/** Runtime parser for public Stream Lifecycle State. */
export const StreamLifecycleStateSchema = z.object({
	isLive: z.boolean(),
	startedAt: z.iso.datetime({ offset: true }).nullable(),
	endedAt: z.iso.datetime({ offset: true }).nullable(),
	peakViewerCount: z.number().int().nonnegative(),
});

/** Current evidence about whether a Stream Session is active. */
export type StreamLifecycleState = z.infer<typeof StreamLifecycleStateSchema>;
