# Changelog

## [Unreleased]

### Fixed

- CI: atualiza `jdx/mise-action` para a v4 e fixa o mise em `2026.9.2` para evitar falhas 404 durante a instalação.

## [1.4.0] - 2026-09-04

### Added

- `pi-memory`: adiciona a tool `memory_read` para ler o markdown canônico completo de memórias ativas, com validação de caminhos e registro de acesso.

### Changed

- `pi-memory`: exige pelo menos cinco termos específicos em português nas buscas, orienta o uso de palavras-chave e frases curtas e exibe o query nos resultados e erros.
- `pi-panel`: melhora a visualização Git com fallback para Git indisponível, diffs como código numerado com linhas removidas e totais do commit, arquivo e branch.
