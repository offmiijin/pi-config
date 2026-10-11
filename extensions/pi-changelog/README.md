# pi-changelog

Mostra o `CHANGELOG.md` da versão atual do pi-config dentro do chat, usando o tema do pi.

## Uso

```text
/pi-changelog
```

A extensão registra uma entrada renderizada em Markdown e não depende de um componente TUI customizado.

## Configuração

Por padrão, o comando lê `~/.pi/agent/CHANGELOG.md`. Para usar outro arquivo, configure `config.json` na extensão:

```json
{
  "changelogPath": "~/.pi/agent/CHANGELOG.md"
}
```

O caminho aceita `~` e caminhos relativos são resolvidos a partir do diretório da extensão. Se o arquivo de configuração estiver ausente, o caminho padrão será usado. Um `changelogPath` inválido gera um aviso e também usa o caminho padrão.

## Testes

```bash
npm run test:pi-changelog
```
