/**
 * Doctor smoke — validação do AMBIENTE REAL (sem mocks).
 *
 * Diferente de tests/doctor.test.ts (unitário, mock de spawnSync), este
 * teste roda as checagens do doctor com o ambiente real: node, binários
 * (bwrap, rg, git, gh), artefatos do sandbox e pacotes npm. Falha se
 * houver qualquer pendência de status "error".
 *
 * Roda via `npm run doctor:check` (CI e uso manual). Rodar sob o vitest
 * garante que a checagem usa o Node real do sistema (process.versions.node),
 * não a versão emulada de outros runtimes.
 */

import { describe, expect, it } from "vitest";
import { runChecks, buildReportText, readOsRelease, detectPackageManager } from "../00-doctor";

describe("doctor smoke (ambiente real)", () => {
	it("ambiente sem pendências (nenhum erro)", async () => {
		const checks = await runChecks({ skipNetwork: true });
		const errors = checks.filter((c) => c.status === "error");
		expect(errors, buildReportText(checks, readOsRelease(), detectPackageManager())).toEqual([]);
	});
});
