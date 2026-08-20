# pi-caveman

Extensão local do Pi para reduzir resultados grandes de ferramentas e manter a
recuperação exata do conteúdo original.

## Escopo inicial

- Compactação determinística de JSON e logs.
- Armazenamento local content-addressed.
- Ferramenta `caveman_retrieve` para recuperar o original.
- Fallback automático para o resultado original quando a compactação não for
  segura, menor ou recuperável.

A extensão não altera providers, autenticação ou o catálogo de modelos e não
inicia processos externos.

## Dados locais

Por padrão, os objetos ficam em `~/.pi/agent/pi-caveman/`. O diretório pode ser
alterado com `PI_CAVEMAN_HOME`.

## Configuração

O arquivo opcional `config.json` aceita:

```json
{
  "enabled": true,
  "minBytes": 2048,
  "maxInputBytes": 2097152,
  "minSavingsBytes": 64
}
```

`PI_CAVEMAN_ENABLED=0` desativa a extensão para a sessão.

## Testes

```bash
npm run typecheck --workspace=extensions/pi-caveman
npm run test --workspace=extensions/pi-caveman
```
