# pi-panel

Painel TUI navegável para visualizar as alterações Git do workspace.

Pressione `Alt+D` no modo interativo para abrir ou fechar o painel. O conteúdo é atualizado após operações do agente, mudanças de árvore da sessão e por polling para alterações externas.

O painel exige modo TUI e usa o diretório efetivo da sessão, incluindo worktrees criados pelo `pi-sandbox`.

## Testes

```bash
npm run test:pi-panel
```
