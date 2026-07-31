---
name: memory
description: Sistema de memória persistente do agente (pi-memory). Usar para salvar, buscar, decair ou extrair memórias (regras, decisões, gotchas, lições, padrões) entre escopos global e por projeto. Memoráveis são arquivos markdown ricos agrupados por contexto.
---

# Memória (pi-memory)

Sistema de memória persistente. Memórias são arquivos markdown organizados por **contexto** (um arquivo = um contexto, com entradas relacionadas). Nunca são injetadas no system prompt — toda recuperação é via tool call.

## Tools Disponíveis

| Tool | Quando usar |
|---|---|
| `memory_status` | Verificar contagem de observações da sessão. Chame periodicamente. |
| `memory_extract` | Processar o session file e transformar observações em memórias. Quando ~50 observações acumuladas. |
| `memory_save` | Salvar/atualizar uma memória diretamente, quando já sabe exatamente o que salvar. |
| `memory_search` | Buscar memórias passadas sobre um tópico (via ripgrep). |
| `memory_decay` | Reduzir confiança de uma memória ou movê-la para `.supersedes/`. |

## Fluxo de Extração

1. **Trabalhe normalmente.** A extensão appenda cada turno no session file automaticamente.
2. **Periodicamente** chame `memory_status` para ver a contagem.
3. **Quando contagem ~50** (threshold atingido), chame `memory_extract`.
4. `memory_extract` lê o session file, analisa as observações com o LLM e salva as memórias identificadas nos diretórios corretos.
5. Continue trabalhando. Repita o ciclo.

## Regras de Memória

### Confiança
- Range: 0.1 a 0.9. Default: 0.5.
- **Só salve memória com confidence >= 0.5.**
- Reforço (nova info consistente) → pode aumentar confidence.
- Contradição → `memory_save` com `supersedes` aponta o contexto antigo; ele vai para `.supersedes/`.
- Perda de relevância → `memory_decay` reduz confidence. Se chegar a 0, vai para `.supersedes/` automaticamente.

### Contexto (agrupamento)
- `context` é a chave de agrupamento. **Mesmo contexto = mesmo arquivo.**
- Sempre reutilize a chave de contexto existente para tópicos relacionados (não crie novo arquivo).
- Contexto deve ser curto e descritivo (ex: `nextjs-app-router`, `testing-standards`).

### Conteúdo
- **Informação rica, nunca atômica.** Escreva conteúdo markdown auto-contido que faça sentido sozinho.
- Cada entrada nova adiciona um `## [data] Título` no arquivo do contexto.

### Escopo
- `global` → vale para TODOS os projetos. Use com parcimônia.
- `project` → específico do projeto atual. Use por padrão.

### Tipo
- `_rules` — convenções que devem ser sempre seguidas
- `decisions` — decisões arquiteturais/design
- `gotchas` — armadilhas, erros, pegadinhas
- `lessons` — aprendizados que generalizam
- `patterns` — padrões de código/design recorrentes

## Estrutura de Diretórios

```
~/.pi/agent/memories/
├── _global/          → memórias de todos os projetos
│   ├── _rules/  decisions/  gotchas/  lessons/  patterns/
├── .supersedes/      → memórias substituídas (espelha estrutura)
└── projects/<id>/    → memórias por projeto
    ├── _rules/  decisions/  gotchas/  lessons/  patterns/
    └── sessions/YYYY-MM-DD/<hash>.md   → observações por sessão
```

## Exemplos

### Salvar memória diretamente
```
memory_save {
  type: "gotchas",
  context: "nextjs-app-router",
  title: "params é Promise em dynamic routes",
  content: "Em Next.js App Router, `params` em dynamic route segments é uma Promise. " +
           "Use `await params` antes de acessar propriedades.",
  scope: "project",
  confidence: 0.7,
  tags: ["nextjs", "app-router"]
}
```

### Buscar memórias
```
memory_search {
  query: "nextjs params",
  scope: "all",
  min_confidence: 0.5,
  limit: 10
}
```

### Substituir memória antiga
```
memory_save {
  type: "gotchas",
  context: "nextjs-app-router-v15",
  title: "searchParams também é Promise",
  content: "Desde Next.js 15, searchParams também é Promise.",
  scope: "project",
  confidence: 0.8,
  supersedes: "nextjs-app-router"   // arquivo antigo vai para .supersedes/
}
```

### Decair memória obsoleta
```
memory_decay {
  context: "nextjs-old-api",
  delta: -0.3,
  reason: "API substituída pela v15"
}
// Se confidence chega a 0, o arquivo é movido para .supersedes/
```

### Decair movendo direto para .supersedes/
```
memory_decay {
  context: "pattern-descontinuado",
  delta: -0.5,
  move_to_supersedes: true,
  reason: "Padrão não faz mais sentido"
}
```
