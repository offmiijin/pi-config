---
name: pi-memory
description: Gerencia memória persistente entre sessões. Usa tools memory_write, memory_search, memory_status e memory_restore_page.
---

# pi-memory

Memória persistente que retém conhecimento através de sessões: preferências, decisões de design, padrões de projeto, lições aprendidas e fatos sobre o projeto.

As memórias são armazenadas como páginas markdown versionadas (com git opcional) em `~/.pi/agent/memory/wiki/`.

## Injeção automática

Toda vez que o usuário envia um prompt, o `pi-memory` busca automaticamente páginas relevantes e as injeta no system prompt como:

```
## Persistent Memory
- [decision] Payment API segue hexagonal architecture `decisions/hexagonal-architecture.md`
- [preference] Prefere pnpm em vez de npm `_rules/prefer-pnpm.md`
```

**Não é necessário chamar `memory_search` para contexto que já aparece no system prompt automaticamente.** Use `memory_search` apenas quando precisar de uma busca mais específica.

## Quando escrever na memória

### Chamar `memory_write` QUANDO

- Usuário declara explicitamente: "grave na memória", "salve isso", "lembre-se", "anote"
- Usuário expressa preferência: "sempre use X", "prefiro Y", "nunca use Z"
- Decisão de arquitetura é tomada: "vamos usar hexagonal", "adotamos event sourcing"
- Padrão de projeto estabelecido: "testes seguem o padrão Given-When-Then"
- Lição aprendida: "o bug estava no cache de 5min, não no código"

### NÃO chamar `memory_write` para

- Informações triviais ou temporárias
- Conversas corriqueiras sem decisão explícita
- O sistema já captura automaticamente observações de tool calls

### Parâmetros da `memory_write`

```typescript
{
  title: "Título descritivo",              // vira filename
  body: "Conteúdo markdown da página",     // pode usar headings, listas, code blocks
  type: "decision | preference | lesson | pattern | fact",
  scope: "project | global",               // global = cross-projeto
  tags: ["tag1", "tag2"],                  // opcional
  path: "decisions/custom-path",           // opcional (gerado automaticamente do title)
}
```

### Tipos de página

| Tipo | Uso | Exemplo |
|---|---|---|
| `decision` | Decisão de arquitetura/design | "Payment API segue hexagonal architecture" |
| `preference` | Preferência do usuário/time | "Prefere pnpm em vez de npm" |
| `lesson` | Lição aprendida | "Timeout OAuth era 5min, não 30s" |
| `pattern` | Padrão de código recorrente | "Testes usam describe/it/expect do vitest" |
| `fact` | Fato objetivo sobre o projeto | "CI/CD usa GitHub Actions com deploy no ECS" |

### Escopo

| Scope | Abrangência |
|---|---|
| `project` | Apenas o projeto atual |
| `global` | Disponível em todos os projetos (preferências pessoais, regras gerais) |

### Tags

Use tags para categorização. Prefira curtas e reutilizáveis:

```
docker deploy typescript pnpm vitest auth api frontend backend ci testing
```

## Quando buscar na memória

Use `memory_search` quando:
1. O contexto automático não cobre o que precisa
2. Precisa de informações específicas de projetos anteriores
3. Vai tomar uma decisão que pode conflitar com preferências salvas
4. Usuário pergunta explicitamente: "o que você lembra sobre X?"

## Quando restaurar versão anterior

Use `memory_restore_page` quando:
1. Usuário diz "desfaz a mudança na página X"
2. Uma decisão foi revertida e a página anterior está correta
3. "Mostra como estava antes"

Options:
- `preview: true` — mostra diff sem restaurar
- `source: "superseded"` — de arquivos `.superseded/` (default)
- `source: "git"` — de histórico git (se habilitado)

## Ferramentas

| Tool | Quando usar |
|---|---|
| `memory_write` | Salvar decisão, preferência, lição como página |
| `memory_search` | Buscar páginas por texto |
| `memory_status` | Verificar estado: total de páginas, breakdown, git status |
| `memory_restore_page` | Restaurar versão anterior de uma página |

## Ciclo de vida

1. **CAPTURE:** Toda tool call gera observação bruta (automático)
2. **EXTRACT:** LLM em background transforma observações em páginas (automático, requer `LLM_API_KEY`)
3. **STORE:** Páginas escritas como markdown em `wiki/` + índice SQLite
4. **CONSOLIDATE:** Sweep periódico aplica decay e pruning (automático)
5. **RETRIEVE:** Busca FTS5 + injeção automática a cada prompt
6. **INJECT:** Bloco `## Persistent Memory` no system prompt
