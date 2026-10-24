# pi-project-context

Detecta automaticamente o contexto operacional do projeto sem executar comandos.

## Detecção

- stack por arquivos (`package.json`, `tsconfig.json`, `deno.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `mix.exs`, `Package.swift`, `pubspec.yaml`, `CMakeLists.txt`, `*.csproj`, `requirements*.txt`, etc.) e dependências conhecidas — incluindo frameworks não-JS lidos de `requirements*`, `Cargo.toml`, `go.mod`, `composer.json`, `Gemfile` e `mix.exs` (Django, Tokio, Gin, Laravel, Rails, Phoenix…);
- versões quando baratas e confiáveis (`.python-version`, diretiva `go`, `engines.node`), como `Python 3.12` no lugar do rótulo base;
- package manager pelo campo `packageManager` ou lockfile;
- comandos `test`, `typecheck`, `lint` e `build` definidos no `package.json`.

O resultado é salvo em `.pi/project-context.json`, como cache derivado e legível
por ferramentas. Um resumo pequeno é injetado no system prompt; `AGENTS.md` não
é alterado automaticamente.
