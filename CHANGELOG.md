# Changelog

## [Unreleased]

### Added

- `pi-web-search`: adiciona renderer local opcional em Python + Playwright para páginas SPA, com comunicação JSONL, instalação posterior via `/web_search config renderer install` e validação de Playwright, Chromium e protocolo.
- `pi-web-search`: adiciona auto-complete para providers, renderer, instalação, status e modos de renderização, além de ajuda detalhada no `/web_search help` e no resumo de configuração.

### Changed

- `pi-panel`: separa alterações do `pi-sandbox` por commit e mantém alterações não commitadas em grupo próprio, usando o worktree e o commit-base da sessão.
- `pi-panel`: exibe o conteúdo do arquivo com pelo menos 10 linhas de contexto por região modificada e permite alternar para o arquivo completo com `F`.
- `pi-sandbox`: transforma `/sandbox` em uma tela interativa de configurações booleanas, com valores `true`/`false`, persistência por escopo e `/sandbox info` para diagnóstico.
- `pi-sandbox`: adiciona `worktree.mode: "in-place"`, mantendo o isolamento do sandbox enquanto permite alterar e commitar diretamente a raiz Git original.
- `pi-sandbox`: permite alternar `worktree`/`in-place` pela tela interativa `/sandbox`.
- `pi-web-search`: `web_fetch` detecta shells de SPA, renderiza JavaScript em modo `auto` e preserva fallback para o fetch HTTP quando o renderer não está disponível.
- `pi-web-search`: exibe progresso e resultado da instalação, permite validar o renderer com `/web_search config renderer status`, bloqueia instalações/uso concorrentes durante a configuração e encerra o Chromium durante `session_shutdown`.

### Removed

- `pi-thinking-level`: remove a extensão e seus testes, scripts e etapas de CI associados.

## [1.2.0] - 2026-08-21

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

### Changed

- `pi-sandbox`: compacta contexto repetido do `grep` e saídas classificadas de testes/logs/JSON do `bash`, preservando falhas, warnings, stack traces e conteúdo desconhecido.
- `pi-caveman`: deixa de processar `read`, `write`, `edit`, `bash`, `grep`, `find` e `ls`, evitando dupla compactação, armazenamento e notificações de recuperação desnecessários.

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
