# pi-panel

Painel TUI navegável para visualizar as alterações Git do workspace.

Pressione `Alt+D` no modo interativo para abrir ou fechar o painel. O conteúdo é atualizado após operações do agente, mudanças de árvore da sessão e por polling para alterações externas. O painel exibe o conteúdo do arquivo com pelo menos 10 linhas de contexto acima e abaixo de cada região modificada; pressione `F` para alternar o arquivo completo.

O painel exige modo TUI e usa o diretório efetivo da sessão. Em worktrees criados pelo `pi-sandbox`, compara o estado atual com o commit-base da sessão e separa as alterações por commit, mantendo mudanças ainda não commitadas em um grupo próprio.

## Testes

```bash
npm run test:pi-panel
```
