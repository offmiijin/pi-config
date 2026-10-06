# pi-document

Fornece a tool `document_extract` para extrair texto de imagens e PDFs locais.

## Uso

A extensão registra automaticamente:

- `document_extract`: recebe `{ "path": "arquivo.pdf" }` ou o caminho de uma imagem;
- uma ponte de clipboard que copia imagens temporárias para `.sandbox-cache/attachments/` antes que o prompt chegue às tools.

A tool aceita imagens BMP, GIF, JPEG, PNG, WebP e TIFF. PDFs são validados pela assinatura `%PDF-` antes da extração.

## Extração

PDFs com camada de texto usam `pdftotext` quando o executável está disponível. PDFs escaneados ou com pouco texto usam OCR via Tesseract.js, renderizando no máximo 20 páginas por padrão.

O OCR usa `por+eng`, DPI 150 e limite de 120 segundos por operação individual. O limite total padrão para um documento é de 5 minutos. Os valores podem ser ajustados pelas opções públicas de OCR, quando as funções são usadas diretamente.

A tool rejeita arquivos maiores que 25 MB e remove os diretórios temporários após a extração.

## Dependências

- `tesseract.js`, `typebox` e `wasm-feature-detect` são dependências npm da extensão;
- `pdftotext` e `pdftoppm` (Poppler) são opcionais: sem eles, PDFs podem usar somente o fluxo disponível de OCR;
- o OCR pode exigir o download/cache dos dados de idioma do Tesseract na primeira execução.

A ausência de Poppler não impede a leitura de imagens, mas limita a extração de PDFs.

## Testes

```bash
npm run test --workspace=extensions/pi-document
```
