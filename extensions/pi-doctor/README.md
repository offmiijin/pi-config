# pi-doctor

Diagnóstico inicial das dependências e artefatos das extensões do pi.

## Verificações

- versão mínima do Node e disponibilidade do npm;
- pacotes npm usados pelas extensões;
- binários como bubblewrap, ripgrep, git, gh e pdftotext;
- artefatos e capacidades necessários ao `pi-sandbox`;
- Docker/SearXNG quando aplicável.

A extensão não depende de pacotes npm externos, para continuar carregando mesmo quando outras extensões estão incompletas.

## Uso

- `/doctor` mostra o relatório completo;
- `doctor_check` expõe o relatório para o agente;
- pendências são notificadas no `session_start`.

## Testes

```bash
npm run test:pi-doctor
```
