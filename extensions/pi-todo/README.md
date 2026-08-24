# pi-todo

Tool e widget para organizar tarefas extensas durante uma sessão do pi.

## Uso

- a tool `todo` gerencia tarefas com `list`, `add`, `update` e `clear`;
- `/todos` mostra a lista completa;
- o widget exibe as primeiras tarefas acima do editor;
- falhas de ferramentas podem marcar automaticamente a etapa ativa como `error`.

O estado é salvo em snapshots da sessão e reconstruído ao iniciar, retomar, fazer fork ou navegar pela árvore.

## Testes

```bash
npm run test:todo
```
