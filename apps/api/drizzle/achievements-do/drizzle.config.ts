import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/achievements-do.schema.ts",
	out: "./drizzle/achievements-do",
	dialect: "sqlite",
});
