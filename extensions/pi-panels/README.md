# pi-panels

Extensão TUI que reúne painéis visuais independentes do Pi.

## Painel de alterações Git

Pressione `Alt+D` no modo interativo para abrir ou fechar o painel de alterações. O conteúdo é atualizado após operações do agente, mudanças de árvore da sessão e por polling para alterações externas. Nos commits e nas alterações ainda não commitadas, o painel exibe diffs e arquivos completos com linhas inseridas e apagadas.

Em worktrees criados pelo `pi-sandbox`, compara o estado atual com o commit-base da sessão e persiste a âncora para sobreviver a reinicializações e recarregamentos.

## Monitor de tokens

Use `/token-monitor` ou `Alt+M` para abrir o monitor de tokens e custos. Ele lê os JSONL das sessões do Pi, oferece os modos Resumo, Tabela e Logs e permite filtrar por período, router e modelo.

Os dois painéis continuam implementados em módulos independentes:

- `changes/` — alterações Git e estado da sessão;
- `token-monitor/` — coleta, agregação e visualização de uso.

## Testes

```bash
npm run test:pi-panels
npm run typecheck:pi-panels
```
