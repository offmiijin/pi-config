# Changelog

## [1.0.0] - 2026-08-10

### Added

- Configuração base do agente com extensões: pi-memory (memória persistente), pi-github (PRs/issues), pi-web-search (pesquisa web), dev-sandbox (quarentena), custom-theme
- Skills de fluxo de trabalho: git-commit (commits semânticos), github-flow (PRs/issues), memory, web-search
- `install.sh` com verificação de kernel (seccomp, landlock, userns) e instalação de dependências
- CI com testes das extensões e verificação de dependências

## Unreleased

### Removed

- Etapa opcional de configuração do SearXNG removida do `install.sh` (Docker + container local); busca local agora configura manualmente via `/web_search config`

### Added

- Instalação automática da configuração do repositório em `~/.pi/agent` com backup automático (PR [#82](https://github.com/offmiijin/pi-config/pull/82))
- Extensão `pi-config-changelog` com comando `/pi-config-changelog` para visualizar o CHANGELOG da versão atual

### Changed

- Nota de quarentena no system prompt (dev-sandbox) passa a listar o critério de decisão dos perfis: `sandbox_fetch` para download (rede, sem acesso ao projeto), `sandbox_quarantine_exec` para instalar/executar código externo (sem rede, sem projeto, escrita só em `.sandbox-cache/runs/<work>`), `sandbox_promote` como única saída de artefatos para o projeto
- Exibição do `/pi-config-changelog` passa a renderizar markdown colorido (tema do pi) com scroll, em vez de texto plano
- Extensão `commands-hub.ts` renomeada para `thinking-level.ts` (comando `/thinking` inalterado)
- `/thinking` passa a derivar os níveis de thinking suportados do modelo ativo via `thinkingLevelMap` (inclui nível `max`; oculta e invalida níveis não suportados, ex.: deepseek v4 só high/max)
- Seleção interativa do `/thinking` usa sufixo `[valor]` na opção e parsing por valor exato (regex), eliminando o parsing frágil por `startsWith`/`includes` de label
- Nível atual não suportado pelo modelo gera aviso e sugere o nível mais próximo (maior suportado ≤ atual; senão o menor suportado)
- Notificações do `/thinking` passam a exibir o modelo ativo; suíte de testes unitários `thinking-level.test.ts` (vitest) adicionada ao CI

### Fixed

- `/pi-config-changelog` não trava mais o TUI — substituído `ctx.ui.custom()` por `appendEntry()` + `registerEntryRenderer()`, que renderiza markdown colorido dentro do chat sem risco de congelamento
- Perfis de quarentena `fetch` e `quarantine` quebrados: `sandbox_fetch` falhava com `curl: (23)` e `sandbox_quarantine_exec` não conseguia ler/escrever no workdir (`Permission denied`). A resolução dos dirs de quarentena usava como base o próprio dir de quarentena (`cwd` do processo), gerando bind mounts aninhados (`<fetch>/.sandbox-cache/fetch`) — o dir real nunca era montado. Novo campo `baseCwd` no `BwrapCall` separa a base dos mounts (workspace) do cwd do processo; testes de regressão adicionados em `bwrap-args.test.ts` e `quarantine.test.ts`
