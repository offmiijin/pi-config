# pi-agent-type

Permite alternar entre os modos `coder`, `planner` e `writer` por meio do comando `/agent`.

Cada modo define o prompt `AGENTS.md`, as tools ativas e, quando necessário, extensões de arquivo permitidas. O estado é persistido na sessão e restaurado ao iniciar, retomar ou navegar pela árvore.

## Uso

```text
/agent
/agent coder
/agent planner
/agent writer
```

O modo `writer`/`planner` pode restringir operações de edição aos arquivos configurados pelo respectivo perfil.
