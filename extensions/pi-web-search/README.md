# pi-web-search

Pesquisa web e coleta o conteúdo completo das páginas para o agente.

## Tools

- `web_search` consulta a cascata SearXNG → Tavily → Exa → Serper;
- `web_fetch` baixa páginas em paralelo, converte HTML para Markdown e preserva arquivos binários;
- `web_agent` coordena pesquisas com múltiplas consultas e coletas.

Configure provedores com `/web_search config <provider> <key>` ou pelas variáveis de ambiente. O SearXNG local pode ser iniciado com Docker Compose.

Os resultados são gravados em `.sandbox-cache/fetch/` no workspace da sessão, para permanecerem acessíveis dentro do `pi-sandbox`.

## Renderer opcional para SPAs

Páginas que dependem de JavaScript podem retornar apenas o shell inicial da aplicação no `web_fetch`. Quando o modo está em `auto`, a extensão tenta usar o renderer local somente quando detecta sinais de SPA.

O renderer usa Python + Playwright e é instalado separadamente:

```text
/web_search config renderer install
```

A instalação também pode ser executada diretamente com `renderer/install.sh`. Ela cria um ambiente virtual do Python em `~/.local/share/pi-web-search/renderer` e instala o Chromium do Playwright.

Modos disponíveis:

- `auto` (padrão): tenta renderizar SPAs e faz fallback para o HTML original;
- `never`: desativa a execução de JavaScript;
- `required`: exige o renderer quando uma página é coletada.

Configure o modo com:

```text
/web_search config renderer auto
/web_search config renderer never
/web_search config renderer required
```

Sem o renderer instalado, o comportamento HTTP original continua funcionando.

## Testes

```bash
npm run test:websearch
```
