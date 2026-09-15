# Changelog

## [Unreleased]

## [1.5.0] - 2026-09-10

### Added

- `pi-project-context`: detecta stack, package manager e comandos do projeto, persiste o contexto em `.pi/project-context.json` e injeta um resumo operacional no system prompt.
- `pi-sandbox`: adiciona a tool `verify` para executar com segurança os scripts de teste, typecheck, lint e build disponíveis no projeto.
- `pi-todo`: reintroduz a visualização persistente acima do editor, com janela deslizante de cinco tarefas e indicador de tarefas restantes.

### Changed

- Padroniza Node.js 24 no instalador, doctor, workspace raiz e CI.
- `pi-todo`: exige execução sequencial das tarefas, exibe o título nas confirmações e usa amarelo para estados de erro em vez de vermelho.
- CI: executa validações reais do sandbox na matriz Ubuntu, Fedora e Arch.
- `pi-web-search`: integra as orientações de pesquisa ao fluxo do agente via `before_agent_start`.
- `pi-custom-theme`: renomeia a extensão para `pi-status-bar`, separando-a dos arquivos JSON de tema.
- `pi-panel` e `pi-token-monitor`: unifica os painéis na extensão `pi-panels`, preservando seus atalhos e comandos.

### Fixed

- `pi-web-search`: bloqueia destinos locais/privados e revalida redirects para reduzir risco de SSRF.
- `pi-hooks`: reforça a detecção de force push para branches protegidas e comandos de download/execução dinâmica.
- `pi-agent-type`: aplica restrições também a arquivos informados sem diretório.

### Removed

- `pi-todo`: remove o comando `/todos` e o atalho `Alt+T`; a visualização permanece disponível no widget persistente.
- Remove as skills separadas `memory` e `web-search`, agora cobertas pelo fluxo integrado do agente.
- Remove a extensão `pi-caveman`, sem uso no fluxo atual.
