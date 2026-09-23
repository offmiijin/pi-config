import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Os testes usam PI_CODING_AGENT_DIR e bancos temporários globais.
		fileParallelism: false,
	},
});
