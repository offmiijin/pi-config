# pi-web-search

Pesquisa web e coleta o conteúdo completo das páginas para o agente.

## Tools

- `web_search` consulta a cascata SearXNG → Tavily → Exa → Serper;
- `web_fetch` baixa páginas em paralelo, converte HTML para Markdown e preserva arquivos binários;
- `web_agent` coordena pesquisas com múltiplas consultas e coletas.

Configure provedores com `/web_search config <provider> <key>` ou pelas variáveis de ambiente. O SearXNG local pode ser iniciado com Docker Compose.

Os resultados são gravados em `.sandbox-cache/fetch/` no workspace da sessão, para permanecerem acessíveis ao `pi-sandbox`.

## Testes

```bash
npm run test:websearch
```
