# Freeway

Rastreador de pedidos de importação (processos GOC/BBI). O plano completo está em [PLANO.md](PLANO.md).

- **App:** https://freeway.devgogroup.com (GoDeploy, id `efa0a79a`, login Google)
- **Dados:** espelho da planilha "Controle de Importações" no `env.DB` (SQLite) + o que é preenchido no app

## Como usar

1. **Planilha:** o Freeway lê sozinho a planilha "Controle de Importações" pela Sheets API a cada 30 minutos (conta de serviço `freeway@produto-491115.iam.gserviceaccount.com`). Em *Configuração* dá para forçar com "Ler agora" ou enviar um .xlsx à mão. A primeira carga é a linha de base e não gera notificações; as seguintes geram eventos para cada mudança (status, ETA, SEFAZ, canal, novo embarque). Se a planilha deixar de ser aberta por link, compartilhe-a com o e-mail da conta de serviço como Leitor.
2. **Montar os times** em *Configuração → Times* (Importação, Itapeva, E-commerce, Filmagem, Ilustração, Marketing).
3. **Observar pedidos** em *Adicionar pedido*. Só pedidos observados aparecem em *Meus pedidos* e geram notificações.

## Como o Freeway enxerga um pedido

- **Cada pedido tem uma página só.** Sem frete ou com um frete, ele aparece com o código do pedido (`BBI25137`, nunca `.1`). **Dividido em mais de um frete, cada frete é um pedido distinto** (`BBI25205.1`, `BBI25205.2`…), com página, itens, barra e lançamento próprios. Não existe página nem processo do "pedido-pai" nem do saldo.
- Cada pedido tem três trilhas, em andares: **Operação** (amostra → FCI), **Site** (mockups, cadastro no site, cadastro no WMS, lançamento) e **Marketing** (filmagem, estampas, marketing).
- **Do pedido original** (iguais em todos os fretes): amostra, produção e alinhamento de matriz.
- **De cada frete**: importação (até chegar em Santos), desembaraço (DUIMP, canal e liberação da SEFAZ), chegada, industrialização, FCI, Site e Marketing. O que foi marcado antes da divisão é herdado até o frete ter valor próprio.
- O "Finalizada" da planilha é **a importação**. O processo só termina quando é **lançado no site** (etapa Lançamento, marcada no app, com data prevista e data em que foi lançado).
- **SKU**: o código vem da coluna "Chave" da planilha; quando falta, do mesmo produto em outra linha; senão do GoProduct pelo nome (`src/data/goproduct-skus.ts`, exportado do GoProduct em 29/10/2026).

## Ligar as integrações (secrets do GoDeploy)

| Secret | Para quê |
|---|---|
| `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `IMPORT_SHEET_ID` | **Configurados.** Leitura automática da planilha a cada 30 min (`/cron/planilha`). Projeto GCP `produto-491115` com a Google Sheets API ativada. |
| `AI_PROXY_TOKEN` | **Configurado.** IA da empresa (`https://ai-proxy.gogroupbr.com/v1/chat/completions`, modelo `latest`) lê as notas livres da planilha dos pedidos observados: resumo, alerta, situação por embarque, pendências (entram nos próximos passos com a marca IA) e rastreios citados. Roda em `/cron/ia` e quando alguém abre o pedido; só chama de novo quando o texto muda. |
| `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET` | Rastreio FedEx das amostras a cada 2 h (`/cron/fedex`). Projeto no FedEx Developer Portal com a Track API. |
| `ADMIN_EMAILS` (opcional) | Admins extras, separados por vírgula. |

Sem esses secrets, as rotinas rodam e não fazem nada.

## Rotinas agendadas

| Rota | Quando (UTC) |
|---|---|
| `/cron/planilha` | a cada 30 min |
| `/cron/fedex` | minuto 15, a cada 2 h |
| `/cron/ia` | minutos 10 e 40: IA lê as notas dos pedidos observados que mudaram (até 10 por vez) |
| `/cron/regras` | 11:00 (08:00 em Brasília): D-5 da produção, prazos estourando |

## Desenvolvimento

```bash
npm install
```

```bash
npm test -- caminho/para/planilha.xlsx
```

O teste roda o worker de verdade contra um SQLite em memória com a planilha real. Para ver as telas localmente, gere o cliente (`npm run build:web`), empacote o servidor local (`npx esbuild test/dev-server.ts --bundle --platform=node --format=esm --outfile=dist/dev-server.mjs`) e rode `node dist/dev-server.mjs caminho/para/planilha.xlsx`.

Para conferir a leitura pela Sheets API daqui: `npx esbuild test/sheets-check.ts --bundle --platform=node --format=esm --outfile=dist/sheets-check.mjs` e `node dist/sheets-check.mjs caminho/da/chave.json ID_DA_PLANILHA`.

**Publicar:** gere `dist/app.js`, monte uma pasta temporária com `src/` (sem `src/icon`), `index.html`, `style.css` e `favicon.svg` de `web/`, `app.js` de `dist/`, `logo.svg` de `src/icon/` e `src/icon/AI.svg` como `ai.svg`. Envie com `getUploadToken` + upload e chame `updateApp` com `entrypoint: "src/index.ts"` e esses seis arquivos em `assets`. O servidor não tem dependências npm, então não precisa de `package.json` (dependência de Node quebra o worker no boot com 502).

**Nova etapa simples:** acrescente uma entrada com `kind: "manual"` em `src/domain/steps.ts`.
