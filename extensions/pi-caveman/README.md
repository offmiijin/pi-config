# pi-caveman

Extensão local do Pi para reduzir resultados grandes de ferramentas e manter a
recuperação exata do conteúdo original.

## Escopo atual

- Compactação determinística de JSON e logs de ferramentas customizadas,
  extensões e integrações externas.
- Armazenamento local content-addressed.
- Ferramenta `caveman_retrieve` para recuperar o original.
- Fallback automático para o resultado original quando a compactação não for
  segura, menor ou recuperável.
- Estatísticas de sessão e comando `/caveman`.

O Caveman não processa `read`, `write`, `edit`, `bash`, `grep`, `find` ou `ls`.
Essas tools são built-ins do Pi e/ou wrappers do `pi-sandbox`; elas conhecem a
semântica da própria saída e aplicam seus limites e compactações diretamente.
Essa exclusão evita uma segunda passagem, armazenamento desnecessário e
notificações duplicadas de recuperação.

A extensão não altera providers, autenticação ou o catálogo de modelos e não
inicia processos externos. Para ferramentas externas, o Caveman continua sendo
um fallback genérico para JSON e logs quando a ferramenta produtora não possui
compressor próprio.

## Instalação e teste manual

A extensão pode ser carregada diretamente durante o desenvolvimento:

```bash
pi -e ./extensions/pi-caveman/index.ts
```

Em uma instalação permanente, coloque o diretório em
`~/.pi/agent/extensions/pi-caveman/` ou configure-o como pacote/extensão do Pi.

## Dados locais

Por padrão, os objetos ficam em `~/.pi/agent/pi-caveman/`. O diretório pode ser
alterado com `PI_CAVEMAN_HOME`.

Cada objeto é armazenado pelo handle derivado do SHA-256 do conteúdo. O store
escreve os objetos de forma atômica e usa permissões privadas. Os bytes originais
não são enviados para nenhum serviço externo.

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

## Comandos

```text
/caveman          status e estatísticas
/caveman stats    estatísticas da sessão
/caveman on       ativa nesta sessão
/caveman off      desativa nesta sessão
/caveman reset    zera as estatísticas da sessão
```

## Testes

```bash
npm run typecheck:pi-caveman
npm run test:pi-caveman
```
