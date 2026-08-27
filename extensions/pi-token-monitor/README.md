# pi-token-monitor

Extensão TUI para acompanhar tokens e custos do Pi através de `/token-monitor` ou `Alt+M`.

## Arquitetura

- `data.ts` é a fonte de dados: percorre os JSONL de sessão, mantém um cache por arquivo (`mtime`/tamanho) e agrega mensagens `assistant` finalizadas.
- `types.ts` define o contrato entre coleta, agregação e interface.
- `panel.ts` implementa o painel overlay e os quatro modos: resumo, tabela, gráficos e detalhes.
- `index.ts` integra comandos, atalho, eventos do Pi e polling de sessões externas.

Os arquivos JSONL em `~/.pi/agent/sessions` (ou `$PI_CODING_AGENT_DIR/sessions`) são a fonte persistente. O cache existe apenas em memória e pode ser reconstruído sem perda de dados.

## Métricas

- `Total gasto`: soma do custo total registrado pelo provider.
- `Requisições`: mensagens `assistant` com uso registrado; retries HTTP não são inferidos.
- `Tokens`: `input + output + cacheWrite`, representando o volume fresco/billable.
- `Cache hit`: `cacheRead / (input + cacheRead + cacheWrite)` quando há tokens de cache informados.

O painel não expõe nem agrega chaves de API.
