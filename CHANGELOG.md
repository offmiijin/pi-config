# Changelog

## [1.0.0] - 2026-08-10

### Added

- Configuração base do agente com extensões: pi-memory (memória persistente), pi-github (PRs/issues), pi-web-search (pesquisa web), dev-sandbox (quarentena), custom-theme
- Skills de fluxo de trabalho: git-commit (commits semânticos), github-flow (PRs/issues), memory, web-search
- `install.sh` com verificação de kernel (seccomp, landlock, userns) e instalação de dependências
- CI com testes das extensões e verificação de dependências

## Unreleased

### Added

- Instalação automática da configuração do repositório em `~/.pi/agent` com backup automático (PR [#82](https://github.com/offmiijin/pi-config/pull/82))
- Extensão `pi-config-changelog` com comando `/pi-config-changelog` para visualizar o CHANGELOG da versão atual

### Changed

- Exibição do `/pi-config-changelog` passa a renderizar markdown colorido (tema do pi) com scroll, em vez de texto plano
- Extensão `commands-hub.ts` renomeada para `thinking-level.ts` (comando `/thinking` inalterado)
- `/thinking` passa a derivar os níveis de thinking suportados do modelo ativo via `thinkingLevelMap` (inclui nível `max`; oculta e invalida níveis não suportados, ex.: deepseek v4 só high/max)

### Fixed

- `/pi-config-changelog` não trava mais o TUI — substituído `ctx.ui.custom()` por `appendEntry()` + `registerEntryRenderer()`, que renderiza markdown colorido dentro do chat sem risco de congelamento
