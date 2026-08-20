# pi-github

Integração com o GitHub por meio da CLI `gh`.

## Tools

Disponibiliza tools para criar, buscar, listar e editar issues e pull requests. A autenticação e a disponibilidade da CLI são verificadas no início da sessão.

## Comando

```text
/github
/github pr create
/github issue list
/github search
/github auth
```

É necessário ter o `gh` instalado e autenticado (`gh auth login` ou `GH_TOKEN`).

## Testes

```bash
npm run test:github
```
