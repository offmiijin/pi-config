# Changelog

## [Unreleased]

### Added

- `pi-memory`: adiciona pendências de sessão (`pending_sessions`) com recuperação de `claimed` órfão de crash no `session_start`.
- `pi-memory`: adiciona jobs de consolidação pré-vinculados por chunk (`session`/`compact`/`manual`) com dedup entre chunks via FTS.
- `pi-memory`: adiciona endereço explícito `scope/tipo/contexto` no `supersedes` e `scope`/`type` opcionais no `memory_decay`.
- `pi-memory`: `/memory config` ganha a opção "Seguir modelo atual" (remove o override e volta ao `settings.json`); `/memory info` mostra a fonte efetiva.
- `pi-panels/memory`: adiciona painel de monitoramento de memórias (`/memory`, `Alt+M`) com filtros por escopo (Todas/Globais/Projeto), por tipo e busca textual, além de preview do `.md` selecionado.

### Changed

- `pi-memory`: o modelo de extração usa `settings.json` (`defaultProvider`/`defaultModel`) como padrão, lido ao vivo; override explícito continua valendo.
- `pi-memory`: consolidação passa a ocorrer na compactação (imediato) e no início da sessão seguinte ao fim (pendência marcada no `shutdown`); remove os gatilhos automáticos por turno (tokens/episódios/sinal forte).
- `pi-memory`: extração automática é estritamente `project-scoped`; memórias globais só via `memory_save` manual.
- `pi-memory`: `.history/` guarda arquivo único por memória (espelho do ativo); a cadeia de versões vive no Git.
- `pi-memory`: `archiveFile` com ordem copy-first (cópia atômica antes de remover o original).
- `pi-memory`: `saveMemory` remove resíduo de `.supersedes/` ao ressuscitar uma key.
- `pi-memory`: `memory_status` conta como elegíveis só episódios `normalized` e exibe sessões pendentes; remove o status morto `failed`.
- `pi-panels`: remapa os atalhos — memórias `Alt+M` (`/memory`), tokens `Alt+T` (`/token-monitor`) e alterações `Alt+C`.
- `pi-panels/memory`: preview com quebra por palavra (sem cortar no meio) e rolagem com `j/k`; colunas de dados alinhadas sob os cabeçalhos, com corte do nome antes de `Conf`.
- `pi-panels/memory`: movimento lateral (`←→`/`h/l`) nos filtros alterna o campo focado (Escopo ↔ Tipo); cima/baixo não trocam de campo.

### Fixed

- `pi-memory`: `commit` Git ignora paths deletados e nunca commitados em vez de falhar o commit inteiro com `fatal: pathspec`.
- `pi-memory`: `recoverStalePendingSessions` evita pendências `claimed` presas após crash entre claim e complete.

## [1.6.0] 2026-10-24

### Added

- `install.sh`: adiciona seleção interativa e flags `--all-optional`/`--no-optional` para instalar dependências opcionais, incluindo Docker/SearXNG, Poppler, renderer Playwright e Rust/Landlock.
- `pi-doctor`: informa recursos opcionais inativos e apresenta os comandos necessários para ativá-los.
- `pi-panels/changes`: adiciona rolagem horizontal com setas e atalhos `H`/`L`, além de navegação para o início (`gg`) e o final (`G`) do arquivo.
- `pi-document`: adiciona a tool `document_extract` para ler imagens e PDFs, usando OCR como fallback.
- `pi-document`: adiciona a biblioteca compartilhada de extração PDF e suporte ao Tesseract.js.
- `pi-todo`: adiciona conclusão automática com resumo final ao concluir todas as tarefas.
- `pi-project-context`: expande a detecção de stacks e frameworks.
- `pi-sandbox`: adiciona instalação de dependências Go, Rust e Python.

### Changed

- `pi-web-search`: documenta SearXNG como opcional e permite instalar o renderer pelo instalador principal.
- `install.sh`: corrige o modo `DRY_RUN` para simular a instalação sem exigir arquivos copiados no destino.
- `pi-panels/changes`: exibe os sinais `+` e `-` nas linhas adicionadas e removidas e aproxima a numeração da barra de divisão.
- `pi-web-search`: reutiliza a biblioteca `pi-document` para extração de texto de PDFs e OCR de documentos escaneados.
- `pi-sandbox`: `verify` consome os `commands` do project-context; alinha `quarantine_exec` com `verify`/`fetch` e reforça download e rede efetiva do `fetch`.

### Fixed

- `pi-panels/changes`: evita vazamento de estilos ANSI entre as colunas durante a rolagem.
- `pi-document`: materializa imagens temporárias do clipboard no workspace para permitir acesso pelo sandbox e declara explicitamente `wasm-feature-detect`.
- `pi-agent-type`: restringe a escrita a arquivos Markdown.
- `pi-doctor`, `pi-document`, `pi-github`, `pi-hooks`, `pi-project-context`, `pi-status-bar` e `pi-panels`: reforça validações, robustez e regras de segurança (diagnóstico do renderer, autenticação, refresh sem rejection e atualização/persistência do contexto).

### Removed

- Remove a extensão externa `pi-mcp-adapter` (`settings.example.json`/`settings.json` sem `packages`); MCP passa a usar apenas `builtin:mcp`.

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
