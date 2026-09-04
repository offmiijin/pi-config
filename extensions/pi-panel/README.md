# pi-panel

Painel TUI navegável para visualizar as alterações Git do workspace.

Pressione `Alt+D` no modo interativo para abrir ou fechar o painel. O conteúdo é atualizado após operações do agente, mudanças de árvore da sessão e por polling para alterações externas. Nos commits e nas alterações ainda não commitadas, o painel exibe as linhas do diff como código, sem cabeçalhos ou prefixos de diff, incluindo linhas inseridas e apagadas com suas respectivas cores. Pressione `F` para alternar entre o diff e o arquivo completo.

O painel exige modo TUI e usa o diretório efetivo da sessão. Em worktrees criados pelo `pi-sandbox`, compara o estado atual com o commit-base da sessão e separa as alterações por commit, mantendo mudanças ainda não commitadas em um grupo próprio. A âncora da sessão é persistida para sobreviver a reinicializações e recarregamentos.

## Testes

```bash
npm run test:pi-panel
```
