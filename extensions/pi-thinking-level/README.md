# pi-thinking-level

Adiciona o comando `/thinking` para consultar e alterar o nível de reasoning/thinking do modelo atual.

O menu considera os níveis suportados pelo modelo, incluindo `xhigh` e `max` quando o catálogo os disponibiliza. Também aceita o nível diretamente como argumento.

## Uso

```text
/thinking
/thinking medium
```

Quando o nível atual não é suportado, a extensão sugere o nível suportado mais próximo sem aumentar o esforço.

## Testes

```bash
npm run test:pi-thinking-level
```
