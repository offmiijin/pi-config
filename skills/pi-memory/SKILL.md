---
name: pi-memory
description: Gerencia memória persistente entre sessões. Usa tools memory_write, memory_search e memory_status para salvar e recuperar conhecimento.
---

# pi-memory

Memória persistente que retém conhecimento através de sessões: preferências, decisões de design, padrões de projeto, lições aprendidas e fatos sobre o projeto.

## Ferramentas

| Tool | Quando usar |
|---|---|
| `memory_write` | Salvar preferência, decisão, padrão, fato ou lição que deve persistir entre sessões |
| `memory_search` | Buscar memórias quando precisar de contexto que não foi injetado automaticamente |
| `memory_status` | Verificar estado do sistema: total de memórias, breakdown por tipo/scope, observações pendentes |

## Injeção automática

Toda vez que o usuário envia um prompt, o `pi-memory` busca automaticamente memórias relevantes e as injeta no system prompt como:

```
## Persistent Memory
- [preference] Todas as extensões devem ser escritas em TypeScript
- [decision] Payment API segue hexagonal architecture
```

**Não é necessário chamar `memory_search` para contexto que já aparece no system prompt automaticamente.** Use `memory_search` apenas quando o contexto automático for insuficiente ou precisar de uma busca mais específica.

## Quando escrever na memória

### SEMPRE escreva quando

- Usuário declara explicitamente: "grave na memória", "salve isso", "lembre-se", "anote"
- Usuário expressa preferência: "sempre use X", "prefiro Y", "nunca use Z", "evite W"
- Uma decisão de arquitetura é tomada: "vamos usar hexagonal", "adotamos event sourcing"
- Um padrão de projeto é estabelecido: "testes seguem o padrão Given-When-Then"
- Uma lição é aprendida com erro: "o bug estava no cache de 5min, não no código"

### Tipos de memória

| Tipo | Uso | Exemplo |
|---|---|---|
| `preference` | Preferência do usuário/time | "Prefere pnpm em vez de npm" |
| `decision` | Decisão de arquitetura/design | "API de pagamentos segue hexagonal architecture" |
| `fact` | Fato objetivo sobre o projeto | "CI/CD usa GitHub Actions com deploy no ECS" |
| `pattern` | Padrão de código/projeto recorrente | "Testes usam describe/it/expect do vitest" |
| `lesson` | Lição aprendida com erro/acerto | "Timeout do OAuth era 5min, não 30s — causava 401" |

### Formato da memória

Cada memória deve ser:
- **Atômica:** um único fato por chamada de `memory_write`
- **Autocontida:** compreensível sem contexto adicional da conversa
- **Específica:** evite generalizações vagas ("o projeto usa boas práticas")
- **Em PT-BR ou EN:** consistente com o idioma do usuário

### Tags

Use tags para categorização. Prefira tags curtas e reutilizáveis:

```
#docker #deploy #typescript #pnpm #vitest #auth #api #frontend #backend #ci
```

## Quando buscar na memória

Use `memory_search` quando:
1. O contexto automático não cobre o que você precisa
2. Precisa de informações de sessões anteriores não relacionadas ao prompt atual
3. Vai tomar uma decisão que pode conflitar com preferências/restrições salvas
4. Usuário pergunta explicitamente: "o que você lembra sobre X?"

## Ciclo de vida da memória

1. **CAPTURE:** Toda tool call gera uma observação bruta (automático)
2. **EXTRACT:** Observações são transformadas em memórias (regex + LLM nas fases futuras)
3. **STORE:** Memórias persistem em SQLite + JSON (~/.pi/agent/memory/)
4. **CONSOLIDATE:** Dedup por hash e último fato vence (automático)
5. **RETRIEVE:** Busca BM25 (FTS5) + injeção automática a cada prompt
6. **INJECT:** Bloco `## Persistent Memory` no system prompt
