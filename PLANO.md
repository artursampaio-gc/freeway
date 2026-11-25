# Freeway — Rastreador de pedidos de importação

Plano do sistema que mostra, em um só lugar, em que pé está cada pedido (processo GOC/BBI), da amostra até o cadastro no site/WMS. Roda no **GoDeploy**, lê a **planilha "Controle de Importações"** do time de importação e usa o **AI Proxy (GPT)** da empresa para ler notas, e-mails e documentos.

> Objetivo: ninguém mais precisa perguntar "em que pé está?" nem atualizar o Monday à mão. Cada pessoa vê **só os pedidos que escolheu observar**, com uma barra de progresso por etapa, e recebe aviso na hora certa.

---

## 1. Visão geral

```
           FONTES                              FREEWAY (app GoDeploy)                       SAÍDAS
┌──────────────────────────┐       ┌───────────────────────────────────────────┐   ┌─────────────────────┐
│ Planilha "Controle de    │──cron▶│ Espelho da planilha + histórico de        │   │ Meus pedidos        │
│ Importações" (Sheets API)│ 30min │ mudanças (ETA, status, SEFAZ...)          │──▶│ (só o que a pessoa  │
│ POs · PIs · Itens · PLs  │       │                                           │   │  observa)           │
├──────────────────────────┤       │  env.DB (SQLite)                          │   ├─────────────────────┤
│ FedEx Track API          │──cron▶│  pedidos · embarques · itens · etapas     │   │ Notificações no app │
│ Correios (fase 3)        │       │  observadores · amostras · e-mails        │──▶│ (sino, por usuário  │
├──────────────────────────┤       │  documentos · eventos · notificações      │   │  e por time)        │
│ Caixa de e-mail da       │─push─▶│                                           │   ├─────────────────────┤
│ importação (fase 2)      │       │  Motor de regras (prazos, gatilhos, D-5)  │──▶│ Slack (fase 2):     │
├──────────────────────────┤       │                                           │   │ DM para quem observa│
│ Sistema de Itapeva       │──────▶│  AI Proxy (GPT): lê notas livres da       │   │ + canal do time     │
│ (fase 3; antes, manual)  │       │  planilha, e-mails e PDF da FCI; resume   │   ├─────────────────────┤
└──────────────────────────┘       │                                           │   │ Caixa de revisão    │
                                   │  Entradas manuais (datas, checks)         │   │ (IA com baixa       │
                                   └───────────────────────────────────────────┘   │  confiança)         │
                                                                                   └─────────────────────┘
```

**Princípios**

1. **Cada um vê o que observa.** A tela principal mostra só os pedidos que a pessoa marcou para observar. Notificações e rastreio externo (FedEx, e-mails) só rodam para pedidos observados.
2. **A planilha continua sendo onde o time de importação trabalha.** O Freeway lê, não pede que ninguém mude de ferramenta. O que não está na planilha (amostra, produção prevista, FCI, mockups, cadastros) é preenchido no app.
3. **O Freeway guarda o histórico que a planilha não guarda.** A planilha sobrescreve valores (o ETA antigo some, não há data real de entrega). O app compara cada leitura com a anterior e registra cada mudança com data.
4. **IA sugere, regra decide.** O GPT extrai fatos (código FedEx, última nota do despacho, número da FCI). Etapas que exigem responsabilidade humana (aprovação de amostra, mockups, cadastros) nunca são concluídas pela IA.
5. **Toda notificação tem destinatário e não se repete.** Cada uma tem uma chave única (`pedido + embarque + etapa + tipo`).

---

## 2. Meus pedidos (lista de observação)

Trazer todos os 463 processos da planilha poluiria a tela e tiraria a agilidade. Por isso:

- **Tela inicial = "Meus pedidos"**: só os pedidos que o usuário logado observa (identificado pelo login Google).
- **Adicionar pedido**: busca por código do processo, descrição, SKU ou fornecedor no espelho da planilha. Por padrão mostra só os processos **Abertos** (117 hoje). O usuário clica em **Observar**. Também dá para criar um pedido manual que ainda não está na planilha.
- **Pedido ativo**: quando a primeira pessoa passa a observar, o rastreio externo começa (FedEx, e-mails) e as notificações passam a ser geradas. Quando ninguém mais observa, o pedido fica **inativo**: os dados da planilha continuam sendo espelhados (é barato), mas sem notificação e sem rastreio externo.
- **Quem mais observa**: o detalhe do pedido mostra as outras pessoas que acompanham, para saber com quem falar.
- **Notificação de pedido que não observo**: quem é de um time (ex.: E-commerce) recebe o aviso da etapa do seu time mesmo sem observar o pedido. Ao abrir pela notificação, pode passar a observar com um clique.

---

## 3. Pedido, embarques e as etapas

**Pedido = processo** (ex.: `GOC25201`, `BBI25205`), uma linha única na aba *Controle POs*. Processos com prefixo **BBI** ligam automaticamente a etapa de Industrialização.

**Até a produção, o pedido é um processo só. Na importação ele se divide em embarques**, mostrados como `BBI25205.1`, `BBI25205.2`… (na planilha: aba *Controle PIs*, `No da PI` = `BBI25205-1`, `BBI25205-2`). Cada embarque tem **seus próprios itens** (aba *Controle PLs*) e sua própria trilha de etapas. Há processos com dezenas de embarques e com produção parcial: o `.1` pode estar em trânsito enquanto o resto ainda está sendo produzido.

| Nível | Etapas |
|---|---|
| **Processo** (`BBI25205`) | Amostra de aprovação, Produção, Alinhamento de Matriz, FCI, Mockups, Cadastro no site, Cadastro no WMS + trilha de **Marketing** (Filmagem, Estampas, Marketing do produto) |
| **Embarque** (`BBI25205.1`, `.2`…) | Importação, Liberação SEFAZ, Chegada, Industrialização (só BBI) |

- O que ainda não foi embarcado aparece como **saldo em produção** (ex.: "578.050 un. ainda na produção") até virar um novo embarque na planilha.
- Embarque sem packing list na planilha (11 PIs hoje) aparece com "itens ainda não informados".
- FCI, mockups e cadastros ficam no processo porque valem para o produto, não para cada lote. A FCI começa quando o **primeiro** embarque chega em Itapeva.

Há **dois envios de amostra diferentes**, tratados separadamente:

| Envio | Para quê | Destino | Etapa |
|---|---|---|---|
| **Amostra de aprovação** | Aprovar o produto antes da produção | **Fortaleza** (padrão; dá para trocar nas raras exceções) | 1 — Amostra |
| **Amostras de alinhamento** | 20 peças para alinhar a matriz sem esperar o lote de verdade chegar | **Extrema** | ★ — Alinhamento de Matriz |

| # | Etapa | Fonte do dado | Como avança | Conclui quando | Notifica |
|---|---|---|---|---|---|
| 1 | **Amostra de aprovação** | FedEx Track API + manual | Usuário informa o código FedEx. O app também procura códigos FedEx nas notas "Outras informações" da planilha e **sugere**: "achei o rastreio 8870…; é da amostra de aprovação?" Rotina consulta a FedEx a cada 2h | Entregue em Fortaleza **e** aprovação registrada **manualmente no app** (aprovado / reprovado / aprovado com restrição + observação) | Quem observa: atraso no envio, exceção na entrega, chegada |
| 2 | **Produção** | Planilha (*Status Produção*) + manual (datas) | Status vem da planilha: Não Iniciado → Em Produção → Parcialmente Pronto → Finalizado. Início e prazo previsto são digitados no app (a planilha só tem essas datas em processos antigos; se tiver, o app pré-preenche). Progresso = dias decorridos / dias previstos, ou quantidade embarcada / total quando "Parcialmente Pronto" | Status "Finalizado" na planilha ou confirmação no app | **D-5 do fim previsto → time de Importação** |
| 3 | **Importação** *(por embarque)* | Planilha (*Controle PIs*); e-mails complementam na fase 2 | Pronto para Embarque → Booking → Em Trânsito → Desembaraço (DUIMP, canal). Mostra ETD, ETA, modal, trader, armador, ref. BL | Liberação SEFAZ do embarque | Quem observa: **ETA mudou**, canal vermelho, embarque On Hold |
| 4 | **Liberação SEFAZ** *(por embarque)* | Planilha (*Liberação Sefaz*) + check manual | Automático quando a data aparece na planilha; o usuário também pode marcar à mão (vale o que vier primeiro) | Data de liberação registrada | **Ao liberar → time de Itapeva** ("BBI25205.2 liberado na SEFAZ") |
| — | **Chegada** *(por embarque)* | Planilha (*Status*) | Entrega Agendada (EXT ou ITPV) → Entregue. A data real de entrega é a data em que o app viu o status mudar | Status "Entregue" | Quem observa: entregue |
| 5 | **Industrialização** *(por embarque, só BBI)* | Manual no MVP (checklist item a item); sistema de Itapeva na fase 3 | Itens **daquele embarque** (*Controle PLs*) com ✓ nos concluídos. Progresso = itens (ou quantidades) concluídos / total do embarque | Todos os itens do embarque concluídos | Quem observa: conclusão parcial (opcional) e **conclusão total** |
| 6 | **FCI** | E-mail com PDF (IA, fase 2) ou upload manual | Começa quando o primeiro embarque chega em Itapeva e corre em paralelo (7 a 10 dias) | PDF anexado e validado | **Quem observa: concluída.** Risco: Itapeva perto de acabar sem FCI |
| 7 | **Mockups** | Manual (link opcional) | Corre em paralelo a tudo desde o início | Usuário marca concluído | **Concluído → time de E-commerce (etapas 8 e 9)** |
| 8 | **Cadastro no site** | Manual (fase 3: checagem automática no banco do site) | Liberado quando mockups concluem | E-commerce marca concluído | Pendente há X dias |
| 9 | **Cadastro no WMS** | Manual | Liberado quando mockups concluem | E-commerce marca concluído | Pendente há X dias |
| ★ | **Alinhamento de Matriz** *(opcional, o usuário liga por pedido)* | FedEx ou Correios + manual | 20 amostras enviadas a **Extrema** com rastreio. **Prazo = entrega das amostras em Extrema + 10 dias** | Usuário marca conclusão | Quem observa: prazo de 10 dias estourando; risco se um embarque for liberado na SEFAZ antes do alinhamento terminar |

### Trilha de desenvolvimento (antes da importação, desde 11/11/2026)

O desenvolvimento do produto acontece antes de existir o pedido. A fonte são os quadros **Launches** do Monday: um item por lançamento, com as tarefas nos subelementos. Enquanto o lançamento não tem pedido, ele aparece na aba **Desenvolvimento**. Quando sai o PO e alguém preenche a coluna **Process** com o código, a trilha passa a aparecer no topo do pedido.

| # | Etapa | Fonte | Conclui quando |
|---|---|---|---|
| 1 | CTR | Coluna Waitlist do Launches; planilha "Acompanhamento - Waitlist/CTR" (aba CTR) | O teste de CTR passou (a waitlist começou) ou foi aprovado na planilha |
| 2 | Waitlist | Tarefa "Waitlist"; aba Status de "Dados - Waitlist" (dias, melhor cor) | A tarefa está pronta ou a waitlist foi concluída no Monday |
| 3 | Definição de cores | Tarefa "Definição de cores" (a melhor cor da waitlist aparece como apoio) | A tarefa está pronta |
| 4 | Fabricação de amostra | Tarefas "Produção da amostra" e "Ajuste da amostra" | A tarefa está pronta ou a amostra já tem rastreio |
| 5 | Envio de amostra | Rastreio FedEx no app (Warehouse Samples) ou a tarefa "Envio da amostra" | A amostra foi entregue |
| 6 | Validação da amostra | Aprovação no app ou a tarefa "Validação da amostra" | A amostra foi aprovada; reprovada = bloqueada |
| 7 | Cadastro no GoProduct | Lista de SKUs × catálogo do GoProduct (lido 1×/dia) | Todos os SKUs da lista estão no GoProduct |
| 8 | Envio de documentação | Pasta do pedido no Drive do FileMaker: PO, carton marks e barcodes | Os arquivos estão na pasta, ou alguém marcou no app |

**Lista de SKUs.** A PO do FileMaker vale primeiro: o arquivo .xlsx da pasta do pedido é lido a cada 30 min. Depois vêm os itens da planilha de importação. Antes das duas, a lista é temporária: alguém digita os SKUs ou envia a lista que o time monta para o supply (.xlsx, .csv, texto colado ou foto). A lista é lida pelas colunas; quando não dá, a IA lê.

**Depois da documentação, a produção começa.** Sem prazo de conclusão, nem na planilha nem no app, o Freeway avisa quem observa o pedido a cada 2 dias úteis até alguém informar o prazo. Depois disso valem o aviso de D-5 e o de produção atrasada.

**Outras regras:**
- As pessoas da coluna People do lançamento passam a observar o pedido ligado a ele. Isso acontece uma vez só: quem deixar de observar não volta a ser incluído.
- Com a produção começada, as etapas anteriores sem registro são dadas como feitas.
- Pedido sem lançamento no Monday: CTR, Waitlist, Cores e Fabricação não se aplicam.

### Trilha de marketing (por processo)

Corre em paralelo à operação e começa quando a amostra de aprovação é aprovada em Fortaleza.

| # | Etapa | Como avança | Conclui quando | Notifica / próximo passo |
|---|---|---|---|---|
| M1 | **Filmagem** | Após a aprovação, as amostras são entregues ao time de filmagem (data registrada no app). O time informa um **prazo** e, quando termina, o **link dos vídeos** | Link dos vídeos registrado | **Amostra aprovada → time de Filmagem.** Prazo da filmagem estourando → quem observa |
| M2 | **Estampas** | Na primeira aprovação da amostra aparece o próximo passo **"Avisar o time de ilustração"**. O time responde: não precisa, ou precisa criar/adaptar (com prazo e link opcional) | "Não precisa" ou estampas concluídas | Botão do próximo passo → time de Ilustração |
| M3 | **Marketing do produto** | Começa quando os vídeos ficam prontos: o time de Marketing recebe o link dos vídeos | Marketing marca como concluído | **Vídeos prontos → time de Marketing, com o link** |

**Novas etapas sem reescrever o app:** as etapas ficam num cadastro único no código (nível, trilha, peso, o que inicia, o que conclui, quem é avisado). Para incluir uma etapa nova basta adicionar uma entrada nesse cadastro.

### Dependências

```
        ── PROCESSO (BBI25205) ──                 ── POR EMBARQUE ──────────────────────────────────────────

Amostra de aprovação ──▶ Produção ──┬──▶ BBI25205.1: Importação ──▶ SEFAZ ──▶ Chegada ──▶ Industrialização (BBI)
     (Fortaleza)           │ D-5    ├──▶ BBI25205.2: Importação ──▶ SEFAZ ──▶ Chegada ──▶ Industrialização (BBI)
                           │        └──▶ saldo ainda em produção (vira .3 quando embarcar)
                           │
                           └─▶ Alinhamento de Matriz (opcional): 20 amostras → Extrema, chegada + 10 dias
                               ideal: concluir antes do 1º embarque ser liberado na SEFAZ

FCI ── começa quando o 1º embarque chega em Itapeva; precisa terminar antes do fim de Itapeva
Mockups (paralelo a tudo) ──┬──▶ Cadastro site
                            └──▶ Cadastro WMS

Marketing: Amostra aprovada ──┬──▶ Filmagem (entrega, prazo, link) ──▶ Marketing do produto (recebe o link)
                              └──▶ Estampas (próximo passo: avisar Ilustração)
```

---

## 4. Planilha "Controle de Importações" (fonte principal)

A planilha enviada (**"Controle de Importações Copy"**, dono murilo.guimaraes@) é uma **cópia só com valores**, atualizada por script **2 vezes por dia (00:28 e 12:28)**, conforme a aba *Log_Sync*. Lendo a cópia, os dados podem ter até 12 h de atraso. O ideal é ler direto da original (pergunta em aberto).

### Abas usadas

| Aba | Grão | Chave | O Freeway usa para |
|---|---|---|---|
| **Controle POs** (463 linhas) | 1 por processo | `Processo` (único, `GOC`/`BBI` + 5 dígitos) | Catálogo para buscar e observar; Status (Aberta / Finalizada / Cancelada); Status Produção; Start/End Production; Supplier, Categoria, Buyer, Descrição; Pendência de Entrega; notas "Outras informações"; link "Pasta Arquivos" |
| **Controle PIs** (1.094) | 1 por embarque | `No da PI` = `Processo-Embarque` (`BBI25205-2` aparece como `BBI25205.2` no app) | Os embarques do pedido: Importação, SEFAZ e Chegada |
| **POs por Item** (3.496) | 1 por item do pedido | `Processo` + `Item Supplier` (não é única: 32 duplicatas) | Itens do pedido: SKU, quantidade, embarcado, pendência, lotes previstos |
| **Controle PLs** (5.040) | 1 por item em cada embarque | `No da PL` (= `No da PI`) + item | Itens dentro de cada embarque: SKU, quantidade, caixas. Base do checklist de industrialização |

### Status do embarque (*Controle PIs* → Freeway)

| Status na planilha | No Freeway | Etapa |
|---|---|---|
| Pronto para Embarque | Pronto para embarque | Importação |
| Booking | Booking (ETD/ETA Booking) | Importação |
| Em Trânsito | Em trânsito (ETD China → ETA Santos) | Importação |
| Desembaraço | Desembaraço (Registro DI/DUIMP, Draft DUIMP, Canal) | Importação |
| *Liberação Sefaz preenchida* | Liberado | SEFAZ |
| Entrega Agendada (EXT) / (ITPV) | Entrega agendada, com destino | Chegada |
| Entregue / Entregue - Ag. Devolução Vazio | Entregue | Chegada |
| On Hold | Bloqueado (vermelho) | — |

### Colunas por etapa

| Etapa | Aba → colunas |
|---|---|
| Produção | *Controle POs*: Status Produção, Start Production, Leadtime, End Production, Pendência de Entrega. *POs por Item*: Embarcado, Pendência de Recebimento, Prev. Embarque (1o lote), ETA 1st–4th Batch |
| Importação | *Controle PIs*: Status, Modal, Trader, Cia., Ref Trading / BL, ETD Booking, ETD China, ETA Booking, ETA Santos, Registro DI/DUIMP, Draft DUIMP, Canal, Dias Desembaraço, Entrega Gocase (previsão), Quantidade, Observação |
| SEFAZ | *Controle PIs*: Liberação Sefaz, Sefaz <> DI, NF, Data NF |
| Amostra | Só texto livre em "Outras informações" (*Controle POs*), de onde o app sugere códigos FedEx |
| Industrialização, FCI, Alinhamento, Mockups, Site, WMS | **Nada na planilha**, vem do app |

### Limpeza dos dados (o leitor precisa tratar)

- Colunas lidas **pelo nome do cabeçalho** (sem espaços nas pontas), nunca pela posição: a planilha tem nomes com espaço no fim ("Descrição "), nomes repetidos ("Status" em várias abas) e colunas sem nome ("Coluna1").
- **Datas** vêm como número serial (dias desde 30/12/1899). Também aceitar texto "dd/mm/aaaa". Viram vazio: "-", "N/A", "Sem Entrada", "SEM DATA PO", 0.
- **Colunas de mês-índice** (1 = jan/2024; ex.: 36 = dez/2026): ETA 1st–4th Batch, Payment 1–4, Prev. Embarque (1o lote), Delivery Month. O valor −2 significa vazio.
- **Erros gravados como texto** (#N/D, #VALOR!, #REF!, #DIV/0!) viram vazio.
- **Valores com espaço ou caixa diferente** ("Finalizado ", "Verde ", "Maersk"/"MAERSK") são normalizados.
- **Linhas inválidas** (placeholder `BBI25XYZ`, itens sem Processo) são ignoradas e listadas num painel de **saúde da sincronização**.
- **Entrega Gocase é previsão** (ETA + Dias Desembaraço), não data real. A data real de entrega é a da mudança de status detectada pelo app.
- **ETA é sobrescrito** na planilha. O app guarda cada valor anterior e avisa quem observa quando muda.

### Como o app lê

- **Em uso (desde 29/10/2026): Sheets API com conta de serviço Google** (`freeway@produto-491115.iam.gserviceaccount.com`). A planilha é compartilhada como leitora com o e-mail da conta de serviço. A rotina `/cron/planilha` (a cada 30 min) chama `values:batchGet` nas 4 abas com `valueRenderOption=UNFORMATTED_VALUE`. A chave da conta (≈1,7 KB) cabe num secret (limite de 4 KB).
- **Custo do banco**: cada aba tem um hash. Se o hash não mudou, nada é gravado. Se mudou, só as linhas com hash diferente são atualizadas, e cada diferença vira um evento.
- **Alternativa** (se a empresa não permitir chave de conta de serviço): um Apps Script na planilha original envia as abas para o app a cada 15–30 min, autenticado com uma API key `gdk_`. O time já tem um script rodando nessa planilha, então dá para estender o mesmo.
- O datamart (`staging.si_purchase_orders`) é só um espelho da aba *POs por Item* e não tem as abas de POs e PIs, por isso **não é usado**.

---

## 5. Barra de progresso e status total

**Por pedido**, uma barra segmentada: um segmento por etapa aplicável, com cor de estado.

| Cor | Estado |
|---|---|
| Cinza | Não iniciado |
| Azul (preenchimento parcial) | Em andamento, no prazo |
| Âmbar | Em risco (faltam ≤ 5 dias para o prazo, ETA escorregou, item parado) |
| Vermelho | Atrasado, bloqueado (On Hold) ou canal vermelho |
| Verde ✓ | Concluído |
| Tracejado | Não se aplica (ex.: Industrialização em GOC, Alinhamento desligado) |

**Na lista**, cada pedido é uma linha com a barra do processo:
- os segmentos de Amostra e Produção são do processo;
- os segmentos de Importação, SEFAZ, Chegada e Industrialização mostram a **média dos embarques ponderada pela quantidade**, sobre a quantidade total do pedido (o saldo ainda em produção conta como 0).

Um clique **abre os embarques** (`.1`, `.2`…), cada um com sua própria barra (Importação → SEFAZ → Chegada → Industrialização) e, dentro de cada embarque, a lista de itens.

**Status total** = média ponderada do progresso das etapas aplicáveis. Pesos iniciais (ajustáveis na configuração):

| Amostra | Produção | Importação | SEFAZ | Industrialização | FCI | Mockups | Site | WMS | Alinhamento |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 25 | 25 | 5 | 10 | 5 | 5 | 5 | 5 | 5 |

Junto com o %: **etapa atual**, **saúde** (no prazo / em risco / atrasado), **próximo marco com data** (ex.: "Embarque 2: ETA Santos 04/11") e **data prevista de conclusão**.

---

## 6. Telas

1. **Meus pedidos** (inicial) — só os pedidos observados, com barra segmentada, % total, etapa atual, próximo marco e badges de alerta. Cada pedido abre para mostrar seus embarques `.1`, `.2`… com barra própria. Filtros: GOC/BBI, etapa, atrasados, em risco.
2. **Adicionar pedido** — busca no espelho da planilha (abertos por padrão); botão **Observar**; criação de pedido manual.
3. **Detalhe do pedido** — resumo em uma frase gerado pela IA; cartões por etapa com dados, prazos e ações (código FedEx, datas, checks, aprovação da amostra); **embarques** `.1`, `.2`…, cada um com barra própria, ETD/ETA, canal, última nota do despacho e **seus itens** (com ✓ da industrialização nos BBI); saldo ainda em produção; documentos (PDF da FCI); link para a pasta de arquivos do processo; quem mais observa; linha do tempo de eventos (inclui mudanças detectadas na planilha).
4. **Notificações** — sino com contador de não lidas em todas as telas; lista por usuário com link direto para o pedido e "marcar como lida".
5. **Caixa de revisão** — sugestões da IA com baixa confiança (código FedEx achado em nota, e-mail sem pedido claro). O usuário confirma ou corrige com um clique.
6. **Configuração** — times (Importação, Itapeva, E-commerce) e membros por e-mail, pesos, prazos padrão, **saúde da sincronização** da planilha (última leitura, linhas ignoradas e motivo) e, na fase 2, preferências de Slack.

---

## 7. Notificações

### Agora: só no app

- Cada regra que dispara cria **uma** notificação (chave única) com destinatários:
  - **quem observa o pedido**, para eventos do pedido (ETA mudou, embarque entregue, chegada de amostra, FCI concluída, industrialização concluída, prazo estourando);
  - **os membros do time**, para gatilhos de time (D-5 → Importação, SEFAZ liberada → Itapeva, Mockups → E-commerce, Amostra aprovada → Filmagem, Vídeos prontos → Marketing, "Avisar Ilustração" → Ilustração).
- **Próximos passos**: além do sino, cada pedido mostra as ações pendentes que dependem de alguém (ex.: "Avisar o time de ilustração", "Entregar amostras à filmagem", "Informar prazo da produção"), com o botão que resolve. Em "Meus pedidos" aparece a lista dos meus próximos passos em todos os pedidos.
- Cada destinatário tem seu "lida/não lida". O sino mostra o contador ao abrir o app.

### Depois: Slack (fase 2)

O motor é o mesmo: a notificação nasce uma vez e um **despachante** entrega em cada canal ligado (`app` hoje, `slack` depois), registrando cada entrega. Ligar o Slack não muda nenhuma regra.

**Recomendação: um app Slack próprio ("Freeway") com token de bot**, em vez de webhooks.

| Opção | O que faz | Limite |
|---|---|---|
| Incoming Webhook | Posta num canal fixo | Um webhook por canal; não manda DM nem sabe quem é quem |
| **App com token de bot** (recomendado) | Posta no canal de cada time **e manda DM para quem observa o pedido**, achando a pessoa pelo e-mail | Precisa de um admin do Slack para aprovar a instalação |
| Workflow Builder com webhook | Dispara um fluxo montado dentro do Slack | Regras espalhadas em dois lugares; depende do plano do Slack |

Como funciona o app com bot:

- **Escopos**: `chat:write` (postar), `users:read` + `users:read.email` (achar a pessoa pelo e-mail do login Google), `im:write` (abrir DM). Token no secret `SLACK_BOT_TOKEN`.
- **Quem é quem**: `users.lookupByEmail` com o e-mail do login → ID do Slack, guardado em cache. Funciona se o e-mail do Slack for o mesmo do Google.
- **Envio**: `chat.postMessage` para o ID da pessoa (DM) ou o canal do time, com mensagem formatada (pedido, embarque, etapa, o que aconteceu) e o link **Abrir no Freeway**.
- **Preferências**: cada usuário escolhe "só app" ou "app + DM no Slack"; cada time escolhe se quer aviso no canal.
- **Retentativa**: envio na hora; uma rotina a cada 5 min reenvia o que falhou.
- **Limitação**: botões que executam ação dentro do Slack (ex.: "marcar SEFAZ liberada") e comandos como `/freeway BBI25016` exigem que o Slack chame o app, e o Freeway fica atrás do login Google. As ações acontecem no app, pelo link. Se fizer falta, dá para criar depois uma ponte pequena que valida a assinatura do Slack e chama o Freeway com uma API key.

---

## 8. Onde a IA (AI Proxy / GPT) entra

| Uso | Entrada | Saída (JSON estruturado) | Aplica sozinho? |
|---|---|---|---|
| **Notas livres da planilha** | "Observação" (*Controle PIs*) e "Outras informações" (*Controle POs*): logs "dd/mm: ..." com o mais recente primeiro | Última nota com data, pendência atual (ex.: "aguardando liberação SEFAZ + NF"), códigos de rastreio, contêiner | Só exibição e sugestão; códigos de rastreio vão para a caixa de revisão |
| **Código FedEx** | Notas da planilha e e-mails | Número(s) de rastreio + processo + qual envio (aprovação ou alinhamento) | Regex acha o código; IA sugere a qual envio pertence; o usuário confirma |
| **Triagem de e-mail** *(fase 2)* | Assunto, corpo, remetente + lista dos **pedidos ativos** | `{processo, embarque, evento, campos, confianca}` | Só preenche o que a planilha não tem (contêiner, chegada efetiva). Se conflitar com a planilha, vale a planilha e o app mostra a diferença |
| **Leitura da FCI** *(fase 2)* | Texto do PDF | Número da FCI, itens/NCM, % de conteúdo importado | Anexa o PDF; marca concluída só se os itens baterem com o pedido |
| **Resumo do pedido** | Estado das etapas, embarques e últimos eventos | 1 a 2 frases | Só exibição |
| **Pergunte ao sistema** *(fase 3)* | "em que pé está o BBI25016?" | Resposta a partir do banco do app | Só leitura; também exposto como ferramenta MCP em `/_mcp` |

**Controle de custo**: a IA só roda para pedidos ativos (observados) e só quando o texto mudou (hash da nota). E-mails de pedidos inativos são guardados sem IA e processados se alguém passar a observar.

Chamadas feitas pelo servidor do app, com `AI_PROXY_URL` e `AI_PROXY_KEY` em secrets. Cada chamada fica registrada (modelo, tokens, origem) para auditoria e custo.

---

## 9. Arquitetura no GoDeploy

### Restrições da plataforma que moldam o desenho

- **Só HTTP + rotinas agendadas (cron).** Não há gatilho de e-mail: os e-mails chegam por **push** (ver 9.3).
- As rotinas agendadas não têm login de usuário, então não usam o datamart. Isso não é problema: a fonte principal é a planilha, lida pela Sheets API com conta de serviço.
- **Máximo de 10 rotinas por app**, intervalo mínimo de 1 minuto e execução "pelo menos uma vez". Toda rotina é idempotente.
- **CPU de 30 s por execução**: a leitura das 4 abas (~10 mil linhas) faz o parse e compara hashes. Se passar do limite, divide-se em uma rotina por aba.
- App **`authenticated`** (login Google), nunca público. Para limitar a um grupo, usar `restricted` pelo console de admin.

### 9.1 Estrutura do código

```
freeway/
├── package.json
├── src/
│   ├── index.ts                 # roteador HTTP (API + rotinas + webhook de e-mail)
│   ├── db/schema.sql            # tabelas do env.DB
│   ├── domain/
│   │   ├── steps.ts             # etapas, pesos, dependências
│   │   ├── progress.ts          # % por etapa, agregação por embarque, saúde, data prevista
│   │   ├── rules.ts             # gatilhos: D-5, SEFAZ→Itapeva, Mockups→E-comm, ETA mudou, prazos
│   │   └── notify.ts            # cria notificação + destinatários; despachante por canal
│   ├── sheet/
│   │   ├── client.ts            # Sheets API: JWT da conta de serviço + values:batchGet
│   │   ├── normalize.ts         # datas seriais, mês-índice, erros em texto, trims, status
│   │   └── sync.ts              # hash por aba/linha, upsert, geração de eventos de mudança
│   ├── integrations/
│   │   ├── fedex.ts             # OAuth + Track API
│   │   ├── aiproxy.ts           # cliente GPT com saída JSON
│   │   ├── slack.ts             # fase 2
│   │   ├── correios.ts          # fase 3
│   │   └── itapeva.ts           # fase 3
│   └── routes/
│       ├── orders.ts            # pedidos, embarques, etapas, observar/deixar de observar
│       ├── notifications.ts     # lista, contador, marcar como lida
│       ├── inbound-email.ts     # POST /api/inbound/email (fase 2)
│       └── cron.ts              # /cron/* com verificação do X-Godeploy-Cron
└── web/
    ├── index.html
    └── app.tsx                  # Preact: meus pedidos, busca, detalhe, notificações, revisão, config
```

### 9.2 Banco (`env.DB`, SQLite)

| Tabela | Campos principais |
|---|---|
| `orders` | `process_code` (único), `description`, `supplier`, `category`, `buyer`, `kind` (GOC/BBI), `po_status`, `production_status`, `po_date`, `files_url`, `notes_raw`, `active`, `needs_industrializacao`, `needs_alinhamento`, `row_hash` |
| `import_shipments` | `pi_number` (único, ex.: BBI25205-2), `display_code` (BBI25205.2), `order_id`, `seq`, `status`, `modal`, `trader`, `carrier_line`, `ref_bl`, `qty`, `etd`, `eta`, `duimp_at`, `draft_duimp`, `canal`, `sefaz_released_at`, `nf`, `nf_date`, `delivery_forecast`, `delivered_at` (detectado), `destination` (EXT/ITPV), `notes_raw`, `row_hash` |
| `order_items` | Itens do processo (antes da divisão): `order_id`, `item_supplier`, `sku`, `sku_key`, `qty`, `shipped_qty`, `pending_qty`, `row_hash` |
| `shipment_items` | Itens de cada embarque (*Controle PLs*): `import_shipment_id`, `item_supplier`, `sku`, `qty`, `boxes`, `industrializado_qty`, `industrializado_at`, `industrializado_by`, `row_hash` |
| `watchers` | `order_id`, `user_email`, `created_at` (único por par) |
| `users` | `email`, `name`, `slack_user_id` (cache, fase 2), `prefs` (JSON) |
| `teams` / `team_members` | `key` (importacao, itapeva, ecommerce), `name`, `slack_channel` / `team_key`, `user_email` |
| `steps` | `order_id`, `step_key`, `status`, `progress`, `started_at`, `due_at`, `completed_at`, `completed_by`, `source` (planilha / manual / api / ia), `data` (JSON) |
| `sample_shipments` | `order_id`, `purpose` (aprovacao / alinhamento), `destination`, `carrier`, `tracking`, `last_status`, `est_delivery`, `delivered_at`, `approval` (resultado, observação, quem, quando) |
| `sheet_syncs` | `tab`, `tab_hash`, `ran_at`, `rows_changed`, `rows_skipped`, `issues` (JSON) |
| `emails` *(fase 2)* | `message_id` (único), `from`, `subject`, `received_at`, `order_id`, `ai_result` (JSON), `confidence`, `status` |
| `documents` | `order_id`, `kind` (fci), `filename`, `content` ou link, `extracted` (JSON) |
| `events` | Linha do tempo: `order_id`, `import_shipment_id`, `step_key`, `type` (ex.: eta_changed), `old_value`, `new_value`, `actor` (e-mail, `planilha`, `system` ou `ai`), `created_at` |
| `notifications` | `notification_key` (único), `order_id`, `import_shipment_id`, `step_key`, `kind`, `title`, `body`, `created_at` |
| `notification_recipients` | `notification_id`, `user_email`, `reason` (observa / time), `read_at` |
| `deliveries` *(fase 2)* | `notification_id`, `channel` (slack), `target`, `status`, `attempts`, `sent_at` |

Índices em `orders(process_code)`, `import_shipments(order_id)`, `watchers(user_email)`, `steps(order_id, step_key)`, `events(order_id, created_at)`, `notification_recipients(user_email, read_at)` para não estourar o limite mensal de custo do banco.

### 9.3 Entrada de e-mails (fase 2)

Com a planilha cobrindo a maior parte da Importação, os e-mails viram complemento: FCI, códigos de rastreio, contêiner e chegada efetiva.

1. Um Apps Script roda a cada 5 min na caixa da importação e busca e-mails novos de despachante, agente ou fornecedor, ou com código GOC/BBI no assunto.
2. Envia para `POST /api/inbound/email` com uma **API key `gdk_`** do GoDeploy: assunto, corpo, remetente, IDs e anexos PDF em base64.
3. O app grava (sem duplicar, pelo `message_id`), aplica o controle de custo da seção 8 e chama o GPT quando for o caso.

### 9.4 Rotinas agendadas (até 10)

| Rota | Frequência | Faz | Fase |
|---|---|---|---|
| `/cron/planilha` | a cada 30 min | Lê as 4 abas, atualiza o espelho, gera eventos de mudança e dispara as regras | 1 |
| `/cron/fedex` | a cada 2h | Atualiza rastreios FedEx não entregues dos **pedidos ativos** (aprovação e alinhamento) | 1 |
| `/cron/regras` | diário, 08h BRT | D-5 da produção, prazo do alinhamento, FCI vs. fim de Itapeva, etapas atrasadas, cadastros parados | 1 |
| `/cron/notas-ia` | a cada 1h | Resume notas da planilha que mudaram, nos pedidos ativos | 2 |
| `/cron/entregas` | a cada 5 min | Reenvia notificações do Slack que falharam | 2 |
| `/cron/itapeva` | a cada 1h | Industrialização item a item (se o sistema tiver API) | 3 |
| `/cron/correios` | a cada 4h | Rastreios dos Correios (amostras de alinhamento) | 3 |
| `/cron/monday` | a cada 30 min | Escreve status e % dos pedidos ativos no board do Monday | 3 |

### 9.5 Secrets (`setAppSecret`)

Fase 1: `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `IMPORT_SHEET_ID`, `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`. Fase 2: `AI_PROXY_URL`, `AI_PROXY_KEY`, `SLACK_BOT_TOKEN`. Fase 3: `CORREIOS_TOKEN`, `ITAPEVA_API_KEY`, `MONDAY_TOKEN`.

---

## 10. Integrações: detalhes e riscos

| Integração | Como | Risco / pendência |
|---|---|---|
| **Planilha de importação** | Sheets API com conta de serviço (seção 4) | Ler a cópia dá até 12 h de atraso; preferir a original. Mudança de nome de coluna quebra a leitura do campo, e o painel de saúde mostra isso |
| **FedEx** | Conta no FedEx Developer Portal, projeto com a **Track API** (gratuita). OAuth client credentials + `POST /track/v1/trackingnumbers`. Usa `latestStatusDetail` e a data estimada de entrega | Precisa da conta FedEx da empresa para criar o projeto |
| **Aprovação da amostra** | **Sempre manual no app**: resultado, observação, quem registrou e quando. Opcional (fase 3): ler também o board Monday "03 - Warehouse Samples" (Approved / Not Approved / Approved w/ Restriction / Waiting) quando alguém do time atualizar por lá. Se os dois existirem, vale o registro manual e o app mostra a divergência | O board nem sempre é atualizado, então não pode ser a única fonte |
| **Correios** | API oficial (CWS) exige contrato e token "Meu Correios". Sem contrato, só serviços de terceiros não oficiais | Definir se há contrato; senão, alinhamento só com FedEx ou rastreio manual |
| **Sistema de Itapeva** | **Ainda não identificado.** No MVP, checklist manual item a item | Descobrir se tem API, banco ou planilha para automatizar na fase 3 |
| **FCI** | Upload manual no MVP; e-mail com PDF → IA na fase 2 | Confirmar de quem/onde vem o PDF |
| **Slack** | App próprio com token de bot (seção 7) | Admin do Slack precisa aprovar; e-mails do Slack precisam bater com os do Google |
| **Site (fase 3)** | Fonte `site` do datamart (tabelas Spree): verificar se o SKU está cadastrado e ativo. O "SKU único"/"Chave" da planilha ajudam no cruzamento | Confirmar se o "site" é o Spree da Gocase. A checagem teria de rodar quando alguém abre o app (o datamart exige login) |
| **WMS** | **Desconhecido** | Manual até saber qual WMS e se tem API |
| **Monday (fase 3)** | API GraphQL com token. Escrever status/% dos pedidos ativos numa coluna do board atual | Fica atualizado sem passo extra; o Monday vira só leitura |

---

## 11. Fases de entrega

### Fase 1: MVP (já resolve o "em que pé está")
- App no GoDeploy com login Google.
- **Leitura da planilha** a cada 30 min: pedidos, embarques e itens, com limpeza, histórico de mudanças e painel de saúde.
- **Meus pedidos** + busca + **Observar** / deixar de observar; criação manual de pedido.
- Pedido único até a produção; a partir da importação, embarques `.1`, `.2`… com barra própria e seus itens. % total, saúde e próximo marco.
- **Automático pela planilha**: status da produção, Importação, SEFAZ e Chegada por embarque.
- **Manual no app**: datas da produção, aprovação da amostra, industrialização item a item por embarque, FCI (upload), mockups, cadastros, alinhamento.
- **FedEx automático** para os dois envios de amostra, com sugestão de código a partir das notas da planilha (regex).
- **Notificações no app** (sino): D-5 → Importação, SEFAZ liberada → Itapeva, Mockups → E-commerce, ETA mudou, embarque entregue, prazo do alinhamento, atrasos.
- **Trilha de marketing**: Filmagem (entrega, prazo, link dos vídeos), Estampas (próximo passo "Avisar o time de ilustração") e Marketing do produto (recebe o link).
- Configuração dos times (Importação, Itapeva, E-commerce, Filmagem, Ilustração, Marketing) e membros; linha do tempo de eventos.
- **Importação da planilha por upload (.xlsx)** na configuração, enquanto o acesso automático não é liberado.

### Fase 2: IA e Slack
- Resumo das notas livres da planilha ("Observação", "Outras informações") e resumo de uma frase por pedido.
- Push de e-mails (Apps Script) + triagem GPT + caixa de revisão, para o que a planilha não tem.
- FCI: PDF anexado e lido automaticamente, com notificação de conclusão.
- **Slack**: DM para quem observa e canal por time, com preferências por usuário.

### Fase 3: Integrações restantes
- Industrialização automática do sistema de Itapeva (item a item, conclusão parcial).
- Aprovação da amostra lida também do board "03 - Warehouse Samples" (complementa o registro manual, não substitui).
- Correios, checagem automática do cadastro no site, WMS (se houver API).
- Escrita automática no Monday.
- `/_mcp` + "Pergunte ao sistema".

---

## 12. Perguntas em aberto

**Resolvidas**
- Notificações: só no app por enquanto; Slack depois (seção 7).
- Dois envios de amostra: aprovação → Fortaleza; alinhamento → 20 peças para Extrema (seção 3).
- Prazo do alinhamento: entrega das amostras em Extrema + 10 dias.
- Aprovação da amostra: sempre manual no app; Monday opcional.
- Sistema de Itapeva: ainda não identificado → checklist manual no MVP.
- Tela inicial: só os pedidos que cada usuário observa.
- Fonte principal: planilha "Controle de Importações". Pedido = processo (único em *Controle POs*).
- Divisão: o pedido é um processo só até a produção; na importação se divide em embarques `.1`, `.2`… (*Controle PIs*), cada um com seus itens (*Controle PLs*).

**Em aberto — travam a fase 1**
1. **Planilha original**: a enviada é a cópia ("Copy"), atualizada 2x por dia por script. Qual é a original e podemos ler direto dela? Se não, aceitamos até 12 h de atraso?
2. **Acesso à planilha**: a empresa permite criar uma conta de serviço do Google (GCP) para leitura? Quem cria? Se não, vamos de Apps Script.
3. **Times**: quem são os membros (e-mails) de Importação, Itapeva e E-commerce?
4. **FedEx**: a empresa já tem conta FedEx com acesso ao Developer Portal?
5. **Destino EXT × ITPV**: embarques entregues em Extrema (EXT) também passam pelo bloco de Itapeva (industrialização, FCI) depois, ou só os entregues em Itapeva (ITPV)?
6. **Status Produção "Serviço"** (75 processos): são processos sem produção física? Escondemos a etapa Produção nesses casos?

**Em aberto — fases 2 e 3**
7. **AI Proxy**: URL base, autenticação, compatibilidade com a API da OpenAI (`/v1/chat/completions`) e modelo.
8. **E-mails da importação**: qual caixa? Remetentes típicos? O código GOC/BBI aparece no assunto?
9. **FCI**: quem emite e como o PDF chega?
10. **Slack**: quem é admin para aprovar o app? Os e-mails do Slack são os mesmos do Google? Quais canais de cada time?
11. **Sistema de Itapeva**: qual é e como exporta os dados? Registra conclusão por item/SKU, quantidade ou lote?
12. **Correios**: existe contrato com acesso à API?
13. **Mockups**: onde são produzidos e guardados (Drive, Monday, outro)?
14. **WMS**: qual sistema?
15. **Acesso ao app**: todos logados na empresa ou só um grupo (`restricted`)?
