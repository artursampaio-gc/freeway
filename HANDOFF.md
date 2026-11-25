# Handoff — Freeway (estado em 30/10/2026)

Leia este arquivo primeiro numa sessão nova. Depois, se precisar de detalhe: `README.md` (uso e operação) e `PLANO.md` (plano original; algumas decisões mudaram e valem as daqui).

## O que é

Rastreador de pedidos de importação da Gocase (processos GOC/BBI). Cada pessoa vê só os pedidos que observa, com barras de progresso em três trilhas e notificações no app.

- **No ar:** https://freeway.devgogroup.com · GoDeploy app **`efa0a79a`** · visibilidade `authenticated` (login Google) · dono artur.sampaio@gocase.com (admin fixo no código).
- **Pasta:** `C:\Users\Notebook\Documents\freeway` (não é repositório git).
- **Stack:** Worker TypeScript sem dependências npm (`src/`) + cliente Preact/htm pré-empacotado em `dist/app.js` (`web/`). Banco `env.DB` (SQLite do GoDeploy: só `query`/`exec`, sem batch; uso `json_each` para gravar em lote).

## Modelo de domínio (decisões do usuário, não mudar sem pedir)

- **Cada pedido tem UMA página.** Sem frete ou com 1 frete → código puro (`BBI25137`). **Nunca mostrar `.1` em pedido de frete único** (nem em avisos/eventos).
- **Dividido em 2+ fretes → cada frete é um pedido distinto** (`BBI25205.1`, `.2`…), com página, itens, barra, lançamento e próximos passos próprios. **Não existe** página do pedido-pai listando fretes nem processo de "saldo" (o usuário reclamou que contava a mais). Rota `#/p/CODE` de pedido dividido redireciona para o 1º frete em aberto; `#/p/X.1` de frete único corrige para `#/p/X`. Na página do frete há só um `<select>` para pular para outro frete.
- **Trilhas em 3 andares:** Operação (Amostra, Produção, Alinhamento, Importação, **Desembaraço**, Chegada, FCI, Industrialização [só BBI]) · Site (Mockups, Site, WMS, Lançamento) · Marketing (Filmagem, Estampas, Marketing).
- **Escopo das etapas** (`src/domain/steps.ts`): `order` = amostra, produção, alinhamento (fato do pedido original, igual em todos os fretes, grava no código do pedido). `unit` = o resto, por frete; o frete **herda** o que foi gravado no código do pedido (antes da divisão) até ter valor próprio (`stateOf` em `view.ts`).
- **Importação** vai até a chegada em Santos; **Desembaraço** = DUIMP + canal + liberação SEFAZ (a chave interna da etapa continua `sefaz` de propósito, para não perder dados). Desembaraço concluído → avisa time Itapeva.
- **"Finalizada" na planilha = importação finalizada**, não o processo. O processo só termina com **Lançamento** marcado no app (campos: data prevista `due`, lançado em `done_at`). Lançado = 100%, sai da lista (toggle "Mostrar lançados") e das pendências.
- **Amostra de aprovação** vai para Fortaleza; **Alinhamento de matriz** = 20 amostras para Extrema, prazo = entrega + 10 dias. Aprovação de amostra é sempre manual no app.
- **Lista de observação por usuário** (watchers por pedido; observar traz todos os fretes). Pedido sem observador não gera notificação.
- **Notificações só no app** (sino). Slack fica para depois (plano: app Slack com bot token, DM por e-mail; ver PLANO.md seção 7).
- **SKU sempre pelo código**, não pelo nome: coluna "Chave" da planilha → mesmo produto em outra linha → catálogo GoProduct (`src/data/goproduct-skus.ts`, 432 IPNs exportados em 29/10). ~94% dos itens de frete com código.
- **UI:** botões óbvios são ícones com tooltip (`web/icons.ts`, `data-tip`); ícone de IA (`src/icon/AI.svg`, servido como `/ai.svg`) com cores girando; logo `src/icon/logo.svg` como máscara. O usuário vai pedindo novas etapas aos poucos: etapa simples = uma entrada `kind: "manual"` em `steps.ts`.

## Fontes de dados e integrações

| Integração | Estado | Onde |
|---|---|---|
| Planilha "Controle de Importações" (Sheets API, conta de serviço `freeway@produto-491115.iam.gserviceaccount.com`) | **Ligada**, `/cron/planilha` a cada 30 min. Planilha id `12W-3sAQy2kczgm--8zhUO7R2g2-tKewFT2kFfnfC3Bg` (é a cópia "Copy", aberta por link). Abas: Controle POs, Controle PIs, POs por Item, Controle PLs | `src/sheet/*` |
| AI Proxy (`https://ai-proxy.gogroupbr.com/v1/chat/completions`, model `latest`, Bearer `AI_PROXY_TOKEN`) | **Ligada**. Lê notas livres por pedido (1 chamada/pedido, só quando o texto muda): resumo, alerta, nota por frete, pendências (viram próximos passos com ícone IA), rastreios. `/cron/ia` (min 10 e 40) e ao abrir a página | `src/domain/ai.ts`, `src/integrations/aiproxy.ts` |
| FedEx Track API | **Código pronto, sem credenciais** (`FEDEX_CLIENT_ID/SECRET`) | `src/integrations/fedex.ts`, `/cron/fedex` |
| Industrialização Itapeva (app GDI `be8422ca`) | **Parado.** O GDI não tem API; a tela lê um Supabase direto. Ler esse Supabase com a chave pública da página **foi barrado por segurança — não tentar de novo**. Usuário pediu acesso oficial ao dono do GDI (sem resposta). Até lá: checklist manual item a item por frete. Secret `ITAPEVA_API_KEY` existe mas sozinho não serve | `src/integrations/itapeva.ts` (só constante) |
| Correios, WMS, Monday, Slack, cadastro no site automático | Não iniciados (fase 3 / depois) | PLANO.md |

Secrets gravados no app: `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `IMPORT_SHEET_ID`, `AI_PROXY_TOKEN`, `ITAPEVA_API_KEY`. Crons ativos: `/cron/planilha` (*/30), `/cron/ia` (10,40), `/cron/fedex` (15 */2), `/cron/regras` (0 11 UTC = 08h BRT: D-5 da produção e prazos).

## Mapa do código

- `src/index.ts` — rotas: `/api/me`, `/api/home` (lista de pedidos = `units` + próximos passos), `/api/search?filtro=andamento|todos`, `/api/process/:code` (pedido inteiro + eventos + docs), `PATCH /api/unit/:unit/step/:step`, `POST /api/unit/:unit/action/:action`, `/api/process/:code/{watch,ia,documents}`, `/api/item-check`, notificações, times, admin (`import-xlsx`, `sync-now`, `status`, `admins`), crons com verificação HMAC.
- `src/domain/view.ts` — **coração**: monta `OrderView` com `units` (um por pedido/frete), etapas, %, saúde, marcos, próximos passos.
- `src/domain/actions.ts` — `updateStep`, `runAction`, `setItemCheck`, `resolveUnit` (aceita `X`, `X.N`, `X-N`; com 1 frete o código aponta para o frete).
- `src/domain/rules.ts` — eventos → notificações (chave única por `nkey`) e regras de prazo. `notify.ts` entrega para observadores + times.
- `src/domain/events.ts` — `unitLabel()` (rótulo sem `.1` para frete único). `NewEvent.unit_label` leva o rótulo até a notificação.
- `src/sheet/` — `google.ts` (JWT RS256 + `values:batchGet`), `xlsx.ts` (unzip próprio com `DecompressionStream`), `normalize.ts` (cabeçalhos por nome, datas seriais, mês-índice, SKU), `sync.ts` (hash por linha, upsert em lote, eventos de mudança; 1ª carga é linha de base sem eventos).
- `web/core.ts` (infra, barras, `Tracks`), `web/process.ts` (Meus pedidos, página do pedido/frete, cartões de etapa, IA), `web/app.ts` (cabeçalho, busca, notificações, configuração, rotas), `web/icons.ts`, `web/style.css`.

## Como testar e publicar

```bash
npm install
```

```bash
npm test -- "C:/Users/Notebook/AppData/Local/Temp/claude/C--Users-Notebook-Documents-freeway/8d766740-e11c-40e0-8151-839300717451/scratchpad/data/controle.xlsx"
```

O teste (`test/run.ts`) roda o worker real em SQLite em memória (`node:sqlite`) com a planilha exportada e IA simulada (`test/fake-ai.ts`). Se o .xlsx do scratchpad sumir: baixe a planilha como .xlsx (ou use `test/sheets-check.ts` com a chave da conta de serviço em Downloads). Tela local: `.claude/launch.json` → `freeway-local` (porta 8791; o 8787 está ocupado na máquina), servindo `dist/app.js` e `dist/dev-server.mjs` (rebuild com esbuild, ver README).

**Publicar** (sempre `updateApp` no `efa0a79a`, nunca `createApp`):
1. `npx tsc --noEmit -p .` e `npm test …` e `npm run build:web`.
2. Montar uma pasta **nova** no scratchpad (não apagar/reusar `deploy/` — `rm` lá é bloqueado) com: `src/` (data, db, domain, integrations, shared, sheet, env.ts, index.ts — **sem** `src/icon`), `index.html`, `style.css`, `favicon.svg` (de `web/`), `app.js` (de `dist/`), `logo.svg` e `AI.svg`→`ai.svg` (de `src/icon/`). **Sem package.json.**
3. `getUploadToken` → `curl -F "caminho=@./caminho" …` para cada arquivo → `updateApp` com `entrypoint: "src/index.ts"` e `assets: ["index.html","style.css","app.js","logo.svg","favicon.svg","ai.svg"]` + `description` atualizada.
4. Conferir com `getAppLogs` (a próxima `/cron/planilha` confirma que o worker sobe).

## Armadilhas já vividas

- **Dependência npm com build de Node quebra o worker no boot (502, logs vazios)** — foi o `fflate`. Manter o servidor sem dependências.
- O usuário não aceita envio manual da planilha: tem que ser automático (já é).
- Cron não tem cookie de usuário → não usa o proxy do datamart.
- O aviso "An RPC result was not disposed properly" nos logs vem da plataforma; ignorar.
- `step_state` guarda o estado manual: escopo = código do pedido (base/herança) ou PI `BBI25205-2` (frete). Estado de frete único também fica na PI.

## Pendências e próximos passos possíveis

- Industrialização automática: aguardando o dono do GDI (`be8422ca`) liberar acesso oficial (rota/MCP no GDI, dados no datamart, ou chave de leitura autorizada).
- FedEx: falta conta/credenciais no FedEx Developer Portal.
- Slack (fase 2), Correios, WMS, checagem de cadastro no site, escrita no Monday, `/_mcp` (fase 3).
- Times em Configuração precisam ser preenchidos pelo usuário para os avisos de time chegarem.
- 307 itens de frete (quase todos de processos antigos) e 330 do pedido seguem sem código de SKU; reexportar o GoProduct de tempos em tempos.
