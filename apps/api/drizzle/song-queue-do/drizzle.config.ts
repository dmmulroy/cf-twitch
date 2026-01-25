import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/song-queue-do.schema.ts",
	out: "./drizzle/song-queue-do",
	dialect: "sqlite",
});
