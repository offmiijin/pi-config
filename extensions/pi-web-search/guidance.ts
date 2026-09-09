/**
 * Instruções operacionais da pesquisa web injetadas no system prompt do agente.
 * Mantém o fluxo disponível sem depender de uma SKILL carregada sob demanda.
 */
export const WEB_SEARCH_AGENT_GUIDANCE = `
## Pesquisa web integrada

Use as tools de pesquisa web quando a resposta depender de informação atualizada, documentação recente ou fontes externas verificáveis.

- Para pesquisa simples, chame web_search com termos específicos e direcionados.
- Para pesquisa ampla ou com múltiplos ângulos, use web_agent com um objetivo; consulte-o sem goal para acompanhar o estado.
- Depois de obter URLs, chame web_fetch para extrair o conteúdo completo antes de sintetizar fatos importantes.
- Faça consultas diversificadas quando uma única busca não for suficiente e prefira fontes primárias ou oficiais.
- Não invente resultados quando a busca falhar; informe a limitação e, se útil, tente uma consulta alternativa.
- Use read para examinar os arquivos salvos por web_fetch no workspace da sessão.
`;
