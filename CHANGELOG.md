# Changelog

## [1.0.0] - 2026-08-10

### Added

- Configuração base do agente com extensões: pi-memory (memória persistente), pi-github (PRs/issues), pi-web-search (pesquisa web), dev-sandbox (quarentena), custom-theme
- Skills de fluxo de trabalho: git-commit (commits semânticos), github-flow (PRs/issues), memory, web-search
- `install.sh` com verificação de kernel (seccomp, landlock, userns) e instalação de dependências
- CI com testes das extensões e verificação de dependências

## Unreleased

### Added

- Instalação automática da configuração do repositório em `~/.pi/agent` com backup automático (PR [#83](https://github.com/offmiijin/pi-config/pull/83))
- Extensão `pi-config-changelog` com comando `/pi-config-changelog` para visualizar o CHANGELOG da versão atual

### Changed

- `doctor_check`/`/doctor` passam a validar `pdftotext` (poppler-utils) para extração de PDF do pi-web-search, com hints de instalação por distro
- `web_fetch` passa a baixar conteúdo não-texto (PDF, imagens, arquivos, ...) como binário para `.sandbox-cache/fetch/`, com extensão derivada do Content-Type (fallback: extensão da URL ou `.bin`), em vez de falhar com `UNSUPPORTED`
- `web_fetch` passa a salvar páginas (texto) em `.sandbox-cache/fetch/page_<id>/` — um único diretório por sessão do pi (mesmo dir dos downloads binários e da raiz de downloads do `sandbox_fetch`), substituindo o antigo `.sandbox-cache/web-fetch/page_*` (um dir por chamada)
- `web_fetch` passa a salvar páginas HTML como Markdown (`.md`) via módulo `html-to-markdown`: estrutura CommonMark preservada (títulos, parágrafos, listas aninhadas, citações, blocos de código com linguagem, ênfase, links resolvidos contra a URL final, imagens, mídia textual), com escape anti-quebra, remoção de tags perigosas, sanitização DOM (comentários, `hidden`, nós vazios, atributos fora da whitelist), escolha de conteúdo (`article`/`main`/`role=main`/`body`) e normalização de espaçamento (fences de código preservados); em vez de `.txt`
- Tabelas no `web_fetch` viram tabelas GFM quando seguras (colunas consistentes, sem `rowspan`/`colspan`>1, células simples, cabeçalho explícito ou primeira linha `th`), com `caption` e escape de `|`; senão caem no fallback `**Cabeçalho:** valor` (rótulos genéricos `Coluna N` sem cabeçalho) — nunca tabela parcialmente quebrada
- Formulários no `web_fetch`: checkbox `[x]`/`[ ]`, radio `(x)`/`( )`, botões viram texto do `value` (sem ação), `label`/`legend` em negrito, `select`/`datalist` viram lista com opção selecionada destacada, `optgroup` com título, `textarea` vira bloco de código, `progress`/`meter` usam texto interno ou `value`; inputs de texto/ocultos ignorados (nunca vira link de submissão)
- `web_agent` passa a distinguir downloads binários no estado da pesquisa (ícone ⬇️ + rótulo "binário" nas Pages Fetched)
- PDFs baixados pelo `web_fetch` ganham extração de texto via `pdftotext` (poppler-utils): texto salvo como `<nome>.txt` ao lado do `.pdf`, legível pelo agente; fallback silencioso (nota no resultado) quando o binário está ausente; detecção por magic bytes `%PDF-` cobre content-type genérico
- Download de binários no `web_fetch` ganha orçamento estendido (60s vs 15s do HTML) — PDFs grandes/servidores lentos não estouram mais o timeout (ex.: manual dos Correios, 3.6MB ≈ 20s)
- Nota de quarentena no system prompt (dev-sandbox) passa a listar o critério de decisão dos perfis: `sandbox_fetch` para download (rede, sem acesso ao projeto), `sandbox_quarantine_exec` para instalar/executar código externo (sem rede, sem projeto, escrita só em `.sandbox-cache/runs/<work>`), `sandbox_promote` como única saída de artefatos para o projeto
- Exibição do `/pi-config-changelog` passa a renderizar markdown colorido (tema do pi) com scroll, em vez de texto plano
- Extensão `commands-hub.ts` renomeada para `thinking-level.ts` (comando `/thinking` inalterado)
- `/thinking` passa a derivar os níveis de thinking suportados do modelo ativo via `thinkingLevelMap` (inclui nível `max`; oculta e invalida níveis não suportados, ex.: deepseek v4 só high/max)
- Seleção interativa do `/thinking` usa sufixo `[valor]` na opção e parsing por valor exato (regex), eliminando o parsing frágil por `startsWith`/`includes` de label
- Nível atual não suportado pelo modelo gera aviso e sugere o nível mais próximo (maior suportado ≤ atual; senão o menor suportado)
- Notificações do `/thinking` passam a exibir o modelo ativo; suíte de testes unitários `thinking-level.test.ts` (vitest) adicionada ao CI

### Removed

- Etapa opcional de configuração do SearXNG removida do `install.sh` (Docker + container local); busca local agora configura manualmente via `/web_search config`
- Diretório órfão `searxng-data/` removido de pi-web-search (volume nomeado antigo substituído por bind mount `./searxng` em 33f9842 — config morta, sem referências)

### Fixed

- `/pi-config-changelog` não trava mais o TUI — substituído `ctx.ui.custom()` por `appendEntry()` + `registerEntryRenderer()`, que renderiza markdown colorido dentro do chat sem risco de congelamento
- Perfis de quarentena `fetch` e `quarantine` quebrados: `sandbox_fetch` falhava com `curl: (23)` e `sandbox_quarantine_exec` não conseguia ler/escrever no workdir (`Permission denied`). A resolução dos dirs de quarentena usava como base o próprio dir de quarentena (`cwd` do processo), gerando bind mounts aninhados (`<fetch>/.sandbox-cache/fetch`) — o dir real nunca era montado. Novo campo `baseCwd` no `BwrapCall` separa a base dos mounts (workspace) do cwd do processo; testes de regressão adicionados em `bwrap-args.test.ts` e `quarantine.test.ts`
