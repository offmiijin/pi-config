# pi-todo

Tool e widget para organizar tarefas extensas durante uma sessão do pi.

## Uso

- a tool `todo` gerencia tarefas com `list`, `add`, `update` e `clear`, sempre em ordem estrita;
- falhas de ferramentas podem marcar automaticamente a etapa ativa como `error`;
- o widget acima do editor e a lista exibida no histórico mostram uma janela deslizante de até cinco tarefas;
- confirmações de atualização exibem o título da tarefa, por exemplo `Tarefa #5 → Título da Tarefa`.

O estado é salvo em snapshots da sessão e reconstruído ao iniciar, retomar, fazer fork ou navegar pela árvore.

## Testes

```bash
npm run test:todo
```
