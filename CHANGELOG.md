# Changelog

## [1.3.0] - 2026-08-28

### Added

- `pi-memory`: adiciona repositório Git aninhado em `memories/`, baseline inicial, commits automáticos por mutação, lock de concorrência e recuperação de commits pendentes.
- `pi-memory`: adiciona a tool read-only `memory_git` para consultar status, histórico, diffs, versões e busca textual das memórias.
- `pi-web-search`: adiciona renderer local opcional em Python + Playwright para páginas SPA, com comunicação JSONL, instalação posterior via `/web_search config renderer install` e validação de Playwright, Chromium e protocolo.
- `pi-web-search`: adiciona auto-complete para providers, renderer, instalação, status e modos de renderização, além de ajuda detalhada no `/web_search help` e no resumo de configuração.
- `pi-memory`: adiciona configuração persistente do modelo do processor via `/memory config`, com autocomplete para `/memory info` e reutilização da autenticação do Pi.
- `pi-token-monitor`: adiciona monitor TUI de tokens e custos a partir dos JSONL de sessão, com `/token-monitor`, `Alt+M`, filtros e modos Resumo, Tabela e Logs.
- `pi-token-monitor`: adiciona seleção paginada de logs, detalhes da requisição e atualização automática durante a sessão.

### Changed

- `pi-memory`: lista todos os modelos dos provedores autenticados, permite busca por qualquer trecho do provider/id/nome e exibe os modelos no formato do `/model`.
- `pi-panel`: separa alterações do `pi-sandbox` por commit, recolhe os arquivos dos commits, mantém alterações não commitadas em grupo próprio, rola a coluna direita e persiste a âncora da sessão para sobreviver a reinicializações.
- `pi-panel`: exibe o conteúdo do arquivo com pelo menos 10 linhas de contexto por região modificada e permite alternar para o arquivo completo com `F`.
- `pi-sandbox`: transforma `/sandbox` em uma tela interativa de configurações booleanas, com valores `true`/`false`, persistência por escopo e `/sandbox info` para diagnóstico.
- `pi-sandbox`: adiciona `worktree.mode: "in-place"`, mantendo o isolamento do sandbox enquanto permite alterar e commitar diretamente a raiz Git original.
- `pi-sandbox`: permite alternar `worktree`/`in-place` pela tela interativa `/sandbox`.
- `pi-web-search`: `web_fetch` detecta shells de SPA, renderiza JavaScript em modo `auto` e preserva fallback para o fetch HTTP quando o renderer não está disponível.
- `pi-web-search`: exibe progresso e resultado da instalação, permite validar o renderer com `/web_search config renderer status`, bloqueia instalações/uso concorrentes durante a configuração e encerra o Chromium durante `session_shutdown`.
- `pi-token-monitor`: mantém o painel compacto, usa seleção de filtros por confirmação, mostra routers autenticados pelo `auth.json` e modelos conforme o período/router.

### Fixed

- `pi-token-monitor`: corrige alinhamento, paginação de 50 logs, navegação por setas, seleção visível, horários, formatação monetária e renderização de grandes volumes.

### Removed

- `pi-thinking-level`: remove a extensão e seus testes, scripts e etapas de CI associados.
