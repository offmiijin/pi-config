# pi-hooks

Hooks de segurança para chamadas de ferramentas do pi.

- `block-force-push.ts` bloqueia `git push --force` para branches protegidas;
- `security-guard.ts` cobre padrões que não são isolados pelo `pi-sandbox`, como fork bombs, download direcionado para shell e avaliação dinâmica.

Os hooks são registrados automaticamente por `index.ts` e atuam sobre chamadas de ferramentas.
