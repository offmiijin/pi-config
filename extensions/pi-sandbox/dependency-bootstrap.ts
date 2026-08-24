/** Diagnóstico de bootstrap de dependências em quarentena offline. */

const PACKAGE_MANAGER = /(?:^|\s)(?:npm|pnpm|yarn|pip(?:\d+)?|python(?:\d+(?:\.\d+)*)?\s+-m\s+pip)(?:\s|$)/i;
const OFFLINE_FAILURE = /(ENOTCACHED|ENETUNREACH|EAI_AGAIN|offline|no matching distribution|could not find a version|no local packages|no cached response)/i;

/**
 * Retorna orientação quando instalação de dependência falha por falta de
 * artefato/cache. Quarentena nunca habilita rede automaticamente.
 */
export function dependencyBootstrapHint(command: string, output: string): string | undefined {
  if (!PACKAGE_MANAGER.test(command) || !OFFLINE_FAILURE.test(output)) return undefined;

  const isPython = /\b(?:pip|python[^\s]*\s+-m\s+pip)\b/i.test(command);
  const artifact = isPython ? "arquivo .whl ou .tar.gz" : "arquivo .tgz";
  const install = isPython
    ? "python -m pip install ./pacote.whl"
    : "npm install ./pacote.tgz";

  return [
    "[pi-sandbox] Bootstrap de dependência não encontrou pacote/cache local.",
    "A quarentena permanece sem rede por segurança.",
    `Use sandbox_fetch para baixar um ${artifact}, passe o caminho em 'artifacts' para sandbox_quarantine_exec e instale o arquivo localmente:`,
    `  ${install}`,
  ].join("\n");
}
