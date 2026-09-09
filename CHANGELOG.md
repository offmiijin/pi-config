# Changelog

## [Unreleased]

### Added

- `pi-project-context`: detecta stack, package manager e comandos do projeto, persiste o contexto em `.pi/project-context.json` e injeta um resumo operacional no system prompt.
- `pi-sandbox`: adiciona a tool `verify` para executar com segurança os scripts de teste, typecheck, lint e build disponíveis no projeto.
- `pi-todo`: reintroduz a visualização persistente acima do editor, com janela deslizante de cinco tarefas e indicador de tarefas restantes.

### Changed

- Padroniza Node.js 24 no instalador, doctor, workspace raiz e CI.
- `pi-todo`: exige execução sequencial das tarefas, exibe o título nas confirmações e usa amarelo para estados de erro em vez de vermelho.
- CI: executa validações reais do sandbox na matriz Ubuntu, Fedora e Arch.

### Fixed

- `pi-web-search`: bloqueia destinos locais/privados e revalida redirects para reduzir risco de SSRF.
- `pi-hooks`: reforça a detecção de force push para branches protegidas e comandos de download/execução dinâmica.
- `pi-agent-type`: aplica restrições também a arquivos informados sem diretório.

### Removed

- `pi-todo`: remove o comando `/todos` e o atalho `Alt+T`; a visualização permanece disponível no widget persistente.

## [1.4.0] - 2026-09-04

### Added

- `pi-memory`: adiciona a tool `memory_read` para ler o markdown canônico completo de memórias ativas, com validação de caminhos e registro de acesso.

### Changed

- `pi-memory`: exige pelo menos cinco termos específicos em português nas buscas, orienta o uso de palavras-chave e frases curtas e exibe o query nos resultados e erros.
- `pi-panels`: melhora a visualização Git com fallback para Git indisponível, diffs como código numerado com linhas removidas e totais do commit, arquivo e branch.

### Fixed

- CI: atualiza `jdx/mise-action` para a v4 e fixa o mise em `2026.9.2` para evitar falhas 404 durante a instalação.
