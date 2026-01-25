import { defineConfig } from "drizzle-kit";

export default defineConfig({
	out: "./drizzle/song-queue-do",
	schema: "./src/durable-objects/schemas/song-queue-do.schema.ts",
	dialect: "sqlite",
	driver: "durable-sqlite",
});
