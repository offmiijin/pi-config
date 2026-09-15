# pi-project-context

Detecta automaticamente o contexto operacional do projeto sem executar comandos.

## Detecção

- stack por arquivos (`tsconfig.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc.) e dependências conhecidas;
- package manager pelo campo `packageManager` ou lockfile;
- comandos `test`, `typecheck`, `lint` e `build` definidos no `package.json`.

O resultado é salvo em `.pi/project-context.json`, como cache derivado e legível
por ferramentas. Um resumo pequeno é injetado no system prompt; `AGENTS.md` não
é alterado automaticamente.
