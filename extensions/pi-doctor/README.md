# pi-doctor

Diagnóstico inicial das dependências e artefatos das extensões do pi.

## Verificações

- versão mínima do Node e disponibilidade do npm;
- pacotes npm usados pelas extensões;
- binários como bubblewrap, ripgrep, git, gh e pdftotext;
- artefatos e capacidades necessários ao `pi-sandbox`;
- Docker/SearXNG quando aplicável, incluindo o serviço inativo e o comando para ativá-lo;
- renderer Playwright opcional e extração de PDF via Poppler, indicando os recursos inativos.

A extensão não depende de pacotes npm externos, para continuar carregando mesmo quando outras extensões estão incompletas. As verificações de arquivos e binários confirmam principalmente presença e disponibilidade básica; elas não substituem um teste completo de execução do sandbox ou do serviço.

O renderer Playwright é resolvido com a mesma precedência do `pi-web-search`: `PI_WEB_RENDERER_COMMAND`, `renderer.command` em `~/.config/pi-web-search/config.json` e, por fim, o caminho padrão.

## Uso

- `/doctor` mostra o relatório completo;
- `doctor_check` expõe o relatório para o agente;
- pendências são notificadas no `session_start`.

## Testes

A suíte unitária usa mocks para testar degradações, mapeamentos e o formato do relatório:

```bash
npm run test:pi-doctor
```

A verificação de smoke consulta o ambiente real e falha quando há pendências críticas:

```bash
npm run doctor:check
```

Os status `warn` e `info` representam recursos opcionais ou modos degradados; somente `error` é considerado uma pendência crítica pelo smoke test.
