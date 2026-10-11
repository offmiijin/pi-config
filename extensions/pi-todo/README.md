# pi-todo

Tool e widget para organizar tarefas extensas durante uma sessão do pi.

## Uso

- a tool `todo` gerencia tarefas com `list`, `add`, `update` e `clear`, sempre em ordem estrita;
- a execução é `sequential`: evita corrida entre chamadas irmãs do mesmo turno (ex.: `add` + `update`);
- falhas de ferramentas podem marcar automaticamente a etapa ativa como `error` (ignora erros da própria `todo` e marca só o primeiro erro entre ferramentas paralelas);
- o widget acima do editor e a lista exibida no histórico mostram uma janela deslizante de até cinco tarefas;
- confirmações de atualização exibem o `[status]` e o título da tarefa, por exemplo `Tarefa #5 [done] → Título da Tarefa`.

O estado é salvo em snapshots da sessão e reconstruído ao iniciar, retomar, fazer fork ou navegar pela árvore. Snapshots corrompidos são pulados (vale o último válido); dados da sessão nunca são confiados sem normalização.

## Conclusão automática

Quando a última tarefa pendente é marcada como `done`, a tool exibe o resumo final no histórico (mensagem `todo_report`, mesmo estilo do `/doctor`) e limpa a lista automaticamente — equivale a um `todo clear`. Use `todo clear` manualmente apenas para descartar uma lista inacabada.

## Testes

```bash
npm run test:todo
```
