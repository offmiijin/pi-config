# pi-hooks

Hooks de segurança para chamadas de ferramentas do pi.

## Hooks

- `block-force-push.ts` bloqueia `git push --force` para `main`/`master` quando a skill `git-commit` está ativa;
- `security-guard.ts` cobre padrões que não são isolados pelo `pi-sandbox`, como fork bombs, download direcionado para shell e avaliação dinâmica.

Os hooks são registrados automaticamente por `index.ts` e atuam sobre chamadas da ferramenta `bash`.

## Configuração

`PI_SECURITY_MODE` controla o `security-guard`:

- `interactive` (padrão): solicita confirmação quando há UI; sem UI, bloqueia;
- `strict`: bloqueia automaticamente;
- `permissive`: permite e exibe um aviso quando há UI;
- `audit-only`: permite e exibe um aviso quando há UI.

Valores desconhecidos retornam ao modo `interactive`. A detecção é baseada em padrões de shell e não substitui o sandbox; comandos equivalentes não cobertos pelos padrões podem escapar da análise.

A proteção de force push analisa o destino explícito do refspec e também bloqueia `--all`/`--mirror`. Ela permanece condicionada à skill `git-commit`; a detecção aceita somente o nome/caminho dessa skill, não qualquer arquivo `SKILL.md`.
