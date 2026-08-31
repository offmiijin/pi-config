# pi-token-monitor

Extensão TUI para acompanhar tokens e custos do Pi através de `/token-monitor` ou `Alt+M`.

## Arquitetura

- `data.ts` é a fonte de dados: percorre os JSONL de sessão, mantém um cache por arquivo (`mtime`/tamanho) e agrega mensagens `assistant` finalizadas.
- `types.ts` define o contrato entre coleta, agregação e interface.
- `panel.ts` implementa o painel overlay e os três modos: resumo, tabela e logs, além do painel de detalhes do log selecionado.
- `index.ts` integra comandos, atalho, eventos do Pi e polling de sessões externas, além do seletor de filtros em overlay menor.

Os arquivos JSONL em `~/.pi/agent/sessions` (ou `$PI_CODING_AGENT_DIR/sessions`) são a fonte persistente. O cache existe apenas em memória e pode ser reconstruído sem perda de dados.

## Métricas

- `Total gasto`: soma do custo total registrado pelo provider.
- `Requisições`: mensagens `assistant` com uso registrado; retries HTTP não são inferidos.
- `Tokens`: `input + output + cacheWrite`, representando o volume fresco/billable.
- `Cache hit`: `cacheRead / (input + cacheRead + cacheWrite)` quando há tokens de cache informados.

O painel não expõe nem agrega chaves de API.

## Uso

- `/token-monitor` abre/fecha o overlay;
- `Alt+M` abre/fecha o overlay;
- `Tab` alterna o foco entre o conteúdo do modo e os filtros;
- `←`/`→` alternam o campo de filtro focado, sem alterar o valor;
- `Enter` abre/confirmar a seleção do filtro;
- `↑`/`↓` navegam pelos itens da Tabela e pelos logs quando o conteúdo está focado;
- `←`/`→` alternam as páginas de Logs quando o conteúdo está focado, com 50 registros por página;
- `Enter` abre os detalhes do log selecionado no modo Logs;
- `V` alterna Resumo, Tabela e Logs;
- `R` força uma atualização;
- `Esc` fecha o painel.

O período `Data personalizada` solicita data inicial e final no formato `DD/MM/AAAA HH:mm`. Pressionar `Enter` sobre Período, Router ou Modelo abre um seletor menor; `Esc` cancela e `Enter` confirma.

As opções de Router mostram apenas os providers com credencial armazenada no `auth.json`. As opções de Modelo são recalculadas usando o período e router atuais, antes de aplicar o filtro de modelo.

O modo Logs exibe as colunas `Data`, `Modelo`, `Provedor`, `Tot. Tok.`, `Tok. Ent.`, `Tok. Saída`, `Cache R/W`, `Custo` e `Sessão` em uma única linha, com 50 registros por página. O horário aparece no formato `HH:MM`, o custo usa de duas a seis casas decimais e a sessão mostra uma versão curta do hash; o painel de detalhes exibe o hash completo.
