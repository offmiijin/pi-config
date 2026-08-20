# Changelog

## [Unreleased]

### Fixed

- `pi-panel`: evita conflito e alternância duplicada do `Alt+D` com o atalho nativo do editor.
- `pi-sandbox`: restaura no `resume` a branch de trabalho persistida no JSONL, preserva branches nomeadas e atualiza o footer após trocas de branch.
- `pi-sandbox`: usa a raiz do projeto como workspace quando não há repositório Git, evitando falha na inicialização.
- `pi-sandbox`: monta a raiz completa do worktree para projetos abertos em subdiretórios e corrige a limpeza de worktrees órfãos registrados no Git.
- `pi-sandbox`: respeita `cleanup: "never"`, rejeita caches/quarentenas que sobreponham o workspace e alinha as opções do perfil normal ao executor.
- `pi-sandbox`: amplia allowlist Landlock com paths de sistema detectados para manter compatibilidade com Nix e ambientes multilib.
- `pi-sandbox`: impede remoção do worktree ativo e criação de worktrees aninhados durante cleanup e testes.
- `pi-sandbox`: substitui detecção baseada somente em PID por lease renovável entre namespaces, preserva cwd relativo/subdiretórios Git e recusa projetos com alterações locais.
- `pi-sandbox`: valida caminhos reais em promoções e bloqueia symlinks que escapem do worktree ou projeto original.
- `pi-sandbox`: reforça quarentena offline, fail-closed para Landlock obrigatório e invalidação do cache de argumentos após mudanças de isolamento.
- `pi-sandbox`: amplia bloqueio de instalação/execução externa sem bloquear `vitest run` ou `npx --no-install vitest`.
- `pi-sandbox`: persiste caches npm, pip e clones na quarentena, limpa artefatos sem atividade há mais de 30 dias e rejeita caminhos com traversal ou symlinks fora do workspace (issue [#97](https://github.com/offmiijin/pi-config/issues/97))
- `pi-sandbox`: mantém caches npm/pip persistentes no projeto original, isola clones, `fetch/` e `runs/` no worktree temporário, mascara `runs/` no perfil normal e corrige a acessibilidade dos arquivos do `web_fetch` (issue [#103](https://github.com/offmiijin/pi-config/issues/103))
- `pi-custom-theme`/`pi-sandbox`: exibe diretório original, branch sandbox abreviado e branch original no footer durante sessões isoladas.
- `pi-todo`: corrige sobreposição da tela quando a última tarefa visível falha, ocultando o motivo do erro na linha da tarefa (issue [#90](https://github.com/offmiijin/pi-config/issues/90))

### Added

- `pi-caveman`: adiciona compressão local de resultados JSON e logs no evento `tool_result`, armazenamento content-addressed com handles `ccr_...`, recuperação exata via `caveman_retrieve`, fallback fail-open, estatísticas de sessão e comando `/caveman`.
- `pi-panel`: adiciona painel TUI flutuante para navegar pelos diffs do worktree, com seleção de arquivos, estatísticas de linhas e atalho `Alt+D`.
- `pi-sandbox`: adiciona `sandbox_promote_preview`/`sandbox_promote_restore` e os comandos `/promote-preview`/`/promote-restore`, com snapshot seguro para live preview e restauração do projeto original.
- `pi-sandbox`: bootstrap seguro de dependências npm no worktree confiável com `npm ci/install --ignore-scripts` e cache persistente.
- `pi-sandbox` passou a executar projetos Git em worktrees temporários descartáveis,
  com cleanup de órfãos, configuração de raiz/política e tool `sandbox_promote_changes`
  para preservar alterações explicitamente.
- `pi-sandbox` monta metadados Git seletivamente, permitindo `status`, branches,
  commits e push sem expor código do projeto original.

### Removed

- `pi-sandbox`: remove a limpeza automática de caches por inatividade após 30 dias; caches persistentes agora permanecem até remoção manual.
- `pi-web-search`: remove a limpeza automática de páginas do `fetch` após sete dias; os arquivos permanecem disponíveis durante a sessão.

## [1.1.0] - 2026-08-16

### Added

- Instalação automática da configuração do repositório em `~/.pi/agent` com backup automático (PR [#83](https://github.com/offmiijin/pi-config/pull/83))
- Extensão `pi-changelog` com comando `/pi-changelog` para visualizar o CHANGELOG da versão atual
- Extensão `pi-todo` com tool única `todo` (list/add/update/clear) para organizar o raciocínio em tarefas extensas: widget TUI acima do editor com as 5 primeiras tarefas e bolinhas coloridas por status (cinza `pending`, amarelo `in-progress`, verde `done`, vermelho `error`), detecção automática de erro (falha de ferramenta marca a etapa ativa como `error`), persistência entre sessões via snapshots em `tool result.details` e comando `/todos` para lista completa
- Extensão `pi-memory` — retenção por inatividade (decay automático por desuso): `retention_score` (relevância operacional) separado de `confidence` (certeza factual, que só o `memory_decay` manual altera — desuso nunca move memórias para `.supersedes/`); frontmatter v3 com `memory_id` (identidade estável, preservada em consolidações e mudanças de tipo) e `retention_policy` (`normal`/`protected`; `_rules` → `protected`); banco de atividade derivado `.retention.sqlite` (`last_used_at`, `use_count`, `retention_score` — markdown continua canônico, sem escrita por leitura); `RetentionScheduler` independente do worker de extração com sweep periódico (reconcile → recompute por meia-vida com grace period → apply no índice); tool `memory_retention` com `status`/`preview` (dry-run sem escrita)/`run`; seção de retenção no `memory_status`; feature flag `RETENTION_ENABLED` (default `false`, rollout seguro); documentação em `docs/retention.md` e 42 testes novos (397 no total)

### Changed

- `pi-sandbox`: compacta contexto repetido do `grep` e saídas classificadas de testes/logs/JSON do `bash`, preservando falhas, warnings, stack traces e conteúdo desconhecido.
- `pi-caveman`: deixa de processar `read`, `write`, `edit`, `bash`, `grep`, `find` e `ls`, evitando dupla compactação, armazenamento e notificações de recuperação desnecessários.
- `pi-sandbox`: mounts de toolchains sob HOME passam a usar apenas diretórios necessários, sem expor árvores inteiras de `.local`, mise ou cargo.
- `doctor_check`/`/doctor` passam a validar `pdftotext` (poppler-utils) para extração de PDF do pi-web-search, com hints de instalação por distro
- `web_fetch` passa a baixar conteúdo não-texto (PDF, imagens, arquivos, ...) como binário para `.sandbox-cache/fetch/`, com extensão derivada do Content-Type (fallback: extensão da URL ou `.bin`), em vez de falhar com `UNSUPPORTED`
- `web_fetch` passa a salvar páginas (texto) em `.sandbox-cache/fetch/page_<id>/` — um único diretório por sessão do pi (mesmo dir dos downloads binários e da raiz de downloads do `sandbox_fetch`), substituindo o antigo `.sandbox-cache/web-fetch/page_*` (um dir por chamada)
- `web_fetch` passa a salvar páginas HTML como Markdown (`.md`) via módulo `html-to-markdown`: estrutura CommonMark preservada (títulos, parágrafos, listas aninhadas, citações, blocos de código com linguagem, ênfase, links resolvidos contra a URL final, imagens, mídia textual), com escape anti-quebra, remoção de tags perigosas, sanitização DOM (comentários, `hidden`, nós vazios, atributos fora da whitelist), escolha de conteúdo (`article`/`main`/`role=main`/`body`) e normalização de espaçamento (fences de código preservados); em vez de `.txt`
- Tabelas no `web_fetch` viram tabelas GFM quando seguras (colunas consistentes, sem `rowspan`/`colspan`>1, células simples, cabeçalho explícito ou primeira linha `th`), com `caption` e escape de `|`; senão caem no fallback `**Cabeçalho:** valor` (rótulos genéricos `Coluna N` sem cabeçalho) — nunca tabela parcialmente quebrada
- Formulários no `web_fetch`: checkbox `[x]`/`[ ]`, radio `(x)`/`( )`, botões viram texto do `value` (sem ação), `label`/`legend` em negrito, `select`/`datalist` viram lista com opção selecionada destacada, `optgroup` com título, `textarea` vira bloco de código, `progress`/`meter` usam texto interno ou `value`; inputs de texto/ocultos ignorados (nunca vira link de submissão)
- Conteúdo editorial no `web_fetch`: `del`/`s`/`strike` → `~~texto~~` (strikethrough GFM), `ins`/`menuitem` como texto simples, `article` aninhado separado por `---` (root selecionado também passa pelo dispatch)
- Tags obsoletas no `web_fetch`: `font`/`basefont`/`tt`/`marquee`/`blink`/`content` como texto interno, `keygen`/`command`/`isindex` removidos, `listing`/`xmp`/`plaintext` viram bloco de código (entidades/raw conforme o parser; `</plaintext>` literal removido)
- `web_agent` passa a distinguir downloads binários no estado da pesquisa (ícone ⬇️ + rótulo "binário" nas Pages Fetched)
- PDFs baixados pelo `web_fetch` ganham extração de texto via `pdftotext` (poppler-utils): texto salvo como `<nome>.txt` ao lado do `.pdf`, legível pelo agente; fallback silencioso (nota no resultado) quando o binário está ausente; detecção por magic bytes `%PDF-` cobre content-type genérico
- Download de binários no `web_fetch` ganha orçamento estendido (60s vs 15s do HTML) — PDFs grandes/servidores lentos não estouram mais o timeout (ex.: manual dos Correios, 3.6MB ≈ 20s)
- Nota de quarentena no system prompt (pi-sandbox) passa a listar o critério de decisão dos perfis: `sandbox_fetch` para download (rede, sem acesso ao projeto), `sandbox_quarantine_exec` para instalar/executar código externo (sem rede, sem projeto, escrita em `.sandbox-cache/runs/<work>` e caches configurados), `sandbox_promote` como única saída de artefatos para o projeto
- Exibição do `/pi-changelog` passa a renderizar markdown colorido (tema do pi) com scroll, em vez de texto plano
- Extensão `commands-hub.ts` renomeada para `thinking-level.ts` (comando `/thinking` inalterado)
- `/thinking` passa a derivar os níveis de thinking suportados do modelo ativo via `thinkingLevelMap` (inclui nível `max`; oculta e invalida níveis não suportados, ex.: deepseek v4 só high/max)
- Seleção interativa do `/thinking` usa sufixo `[valor]` na opção e parsing por valor exato (regex), eliminando o parsing frágil por `startsWith`/`includes` de label
- Nível atual não suportado pelo modelo gera aviso e sugere o nível mais próximo (maior suportado ≤ atual; senão o menor suportado)
- Notificações do `/thinking` passam a exibir o modelo ativo; suíte de testes unitários `thinking-level.test.ts` (vitest) adicionada ao CI
- `memory_search` passa a registrar o uso dos resultados (engine SQLite e fallback ripgrep) no `.retention.sqlite` quando a retenção está ativa — busca vazia não registra, falha do store degrada sem quebrar a busca e o bump do score é imediato no índice
- Índice FTS do `pi-memory` passa para schema v3: colunas `retention_score` e `memory_id` em `memory_documents` (migração via ALTER idempotente); ordenação da busca passa a usar `retention_score` como critério secundário (BM25 → confidence → retention_score → updated → path), sem dominar a relevância lexical

### Removed

- Etapa opcional de configuração do SearXNG removida do `install.sh` (Docker + container local); busca local agora configura manualmente via `/web_search config`
- Diretório órfão `searxng-data/` removido de pi-web-search (volume nomeado antigo substituído por bind mount `./searxng` em 33f9842 — config morta, sem referências)

### Fixed

- `html-to-markdown`: âncoras de header com texto invisível (ex.: `[​](url)` com zero-width space em VitePress/Nextra) eram emitidas como link vazio — agora descartadas; link sem texto visível vira a URL como texto
- `html-to-markdown`: elementos com `data-as="p"` (padrão shadcn/nextra) eram tratados como inline e grudavam no bloco anterior — agora viram parágrafo
- `html-to-markdown`: nó de whitespace entre um bloco e um inline "engolia" a fronteira, colando o inline ao bloco (`...](url)In the examples`) — fronteira preservada
- `html-to-markdown`: conteúdo inline diretamente após um bloco (ex.: `<strong>` depois de `<h1>` sem `<p>`) era silenciosamente descartado pelo join de blocos — corrigido e coberto por teste de regressão (Fase 7 de aceite)
- `/pi-changelog` não trava mais o TUI — substituído `ctx.ui.custom()` por `appendEntry()` + `registerEntryRenderer()`, que renderiza markdown colorido dentro do chat sem risco de congelamento
- Perfis de quarentena `fetch` e `quarantine` quebrados: `sandbox_fetch` falhava com `curl: (23)` e `sandbox_quarantine_exec` não conseguia ler/escrever no workdir (`Permission denied`). A resolução dos dirs de quarentena usava como base o próprio dir de quarentena (`cwd` do processo), gerando bind mounts aninhados (`<fetch>/.sandbox-cache/fetch`) — o dir real nunca era montado. Novo campo `baseCwd` no `BwrapCall` separa a base dos mounts (workspace) do cwd do processo; testes de regressão adicionados em `bwrap-args.test.ts` e `quarantine.test.ts`
