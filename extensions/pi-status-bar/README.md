# pi-status-bar

Componentes visuais para o TUI do pi.

Registra o editor customizado (badge do tipo de agente, modelo, provedor, uso de contexto, tokens, custo, memórias e versão do pi) e o footer (pasta, branch git e estado do workspace isolado). Também reflete estatísticas emitidas pelo `pi-memory` e trocas do agente-switcher.

Os componentes só são registrados com UI ativa (`session_start` sem UI é ignorado); entradas da sessão e payloads de eventos nunca são confiados sem validação — valores ausentes ou corrompidos caem para padrões (`coder`, `off`, `unknown`, `no-branch`).

A extensão é carregada pelo entrypoint `index.ts`; não possui comando próprio. Temas continuam sendo definidos separadamente em arquivos JSON no diretório `themes/`.

## Testes

```bash
npm run test:pi-status-bar
```
