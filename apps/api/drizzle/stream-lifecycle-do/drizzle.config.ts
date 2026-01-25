import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/stream-lifecycle-do.schema.ts",
	out: "./drizzle/stream-lifecycle-do",
	dialect: "sqlite",
});
