# pi-github

Integração com o GitHub por meio da CLI `gh`.

## Tools

Disponibiliza tools para criar, buscar, listar, visualizar e editar issues e pull requests:

- `github_create_pr` e `github_create_issue`: criam itens com título no padrão Conventional Commits;
- `github_search`, `github_list_prs` e `github_list_issues`: consultam o repositório atual;
- `github_pr_view` e `github_issue_view`: exibem corpo, labels, assignees e comentários;
- `github_edit_pr` e `github_edit_issue`: alteram campos e substituem labels/assignees por diff.

Números devem ser positivos, limites ficam entre 1 e 100 e repositórios seguem `owner/name`. Edições sem alterações são rejeitadas antes de chamar a CLI.

A autenticação e a disponibilidade da CLI são verificadas no início da sessão, com timeout de 8 segundos para não bloquear indefinidamente o carregamento.

## Comando

```text
/github
/github pr create
/github issue list
/github search
/github auth
```

É necessário ter o `gh` instalado e autenticado (`gh auth login` ou `GH_TOKEN`). Sem `gh`, as tools não são registradas e a extensão informa o comando de instalação adequado ao sistema operacional. Por padrão, as operações usam o repositório atual; informe `repo: "owner/name"` quando a tool permitir um repositório alternativo.

## Testes

```bash
npm run test:github
```
