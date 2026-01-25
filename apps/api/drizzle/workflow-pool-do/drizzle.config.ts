import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/workflow-pool-do.schema.ts",
	out: "./drizzle/workflow-pool-do",
	dialect: "sqlite",
});
