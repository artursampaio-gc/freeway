// Formato das respostas da API, usado pelo servidor e pela tela.

export type StepStatus = "na" | "todo" | "doing" | "risk" | "late" | "done" | "blocked";
export type Health = "ok" | "risk" | "late";

/** Situação do pedido: em andamento, on hold (no app ou o frete na planilha), cancelado (no app ou na planilha) ou lançado no site. */
export type Situacao = "andamento" | "on_hold" | "cancelado" | "lancado";

/** Nota de importação de um frete, lida da planilha do time fiscal (Notas de Importação). */
export interface FiscalNoteView {
  /** Referência da trading (IMP-02/13796, WMFIMP-26/2084, I-MAR-2268-26…). */
  processo: string;
  empresa: string | null;
  duimp: string | null;
  /** Situação como o fiscal escreve ("Bloqueada no painel", "Emitida"…). */
  status: string | null;
  state: StepStatus;
  /** Extrato da DUIMP, Planilha do despachante, Conferência, Grokbot, Lançada no WebGex, Emitida. */
  etapas: { label: string; value: string; mark: "done" | "doing" | "risk" | "blocked" | "todo" }[];
  nf: string | null;
  valor: string | null;
  falta: string | null;
  mudou: string | null;
  /** Como ligou ao frete: ref (Ref Trading / BL), pi (PI escrita), historico (códigos do Histórico) ou nf. */
  via: string | null;
  updated_at: string | null;
}

/** Cancelado ou on hold marcado no app, com o motivo e quem marcou. */
export interface HoldView {
  state: "cancelado" | "on_hold";
  note: string | null;
  by: string | null;
  at: string;
}

export interface StepView {
  key: string;
  label: string;
  short: string;
  track: "desenvolvimento" | "operacao" | "site" | "marketing";
  scope: "order" | "unit";
  status: StepStatus;
  progress: number;
  detail: string;
  due?: string | null;
  /** Estado salvo da etapa (campos manuais). */
  data?: Record<string, any>;
  /** Origem do dado principal: planilha, manual, fedex, inferido. */
  source?: string;
  /** Num embarque: o valor vem do que foi marcado no pedido. */
  inherited?: boolean;
  /** Pontos a cumprir dentro da etapa (ex.: documentação do pedido na Produção). */
  points?: StepPoint[];
}

export interface StepPoint {
  key: string;
  label: string;
  hint?: string;
  done: boolean;
  /** Dado como feito sem registro no app (ex.: o pedido já embarcou). */
  inferred?: boolean;
  done_at?: string | null;
  done_by?: string | null;
  link?: string | null;
  link_label?: string;
  /** Campo da etapa que guarda a data de conclusão do ponto. */
  field: string;
}

export interface ItemView {
  id: string;
  item_supplier: string | null;
  /** Nome do produto (SKU único da planilha). */
  name: string | null;
  /** Código do SKU (Chave da planilha, completado pelo GoProduct quando falta). */
  code: string | null;
  qty: number | null;
  boxes?: number | null;
  shipped_qty?: number | null;
  pending_qty?: number | null;
  done_at?: string | null;
  done_by?: string | null;
  /** Quanto o GDI (Itapeva) já industrializou deste item e quanto está em OP aberta. */
  gdi?: { done: number; doing: number; ops: string[] } | null;
  /** Situação do item em cada frente (célula da lista de produtos). */
  status?: Record<ItemKind, ItemCell>;
  /** Saldo no WMS (todas as variações do código), por local, e o detalhe por código e armazém. */
  stock?: { itapeva: number; extrema: number; linhares: number; outros: number; detail: string[] } | null;
  /** Cadastro do produto na planilha de produtos (supply). */
  product?: { sku_unico: string | null; status: string | null; origem: string | null } | null;
  /** Id (pk) do produto no GoProduct, para o link da página dele. */
  goproduct?: number | null;
  /** Miniatura do produto (rota do Freeway que serve a imagem do GoProduct). */
  goproduct_img?: string | null;
  /** Item que veio da lista de SKUs (PO do FileMaker ou lista temporária), antes dos itens da planilha. */
  origin?: string;
}

export type ItemKind = "fci" | "industrializacao" | "cadastro" | "wms" | "lancado";

export interface ItemCell {
  state: "done" | "doing" | "todo" | "na";
  /** De 0 a 1, quando há como medir (peças industrializadas, itens marcados no frete). */
  pct?: number;
  detail: string;
  /** Marcado à mão neste item (pode desmarcar). */
  marked?: boolean;
}

export interface ShipmentInfo {
  status: string;
  status_label: string;
  destination: string | null;
  modal: string | null;
  trader: string | null;
  carrier_line: string | null;
  ref_bl: string | null;
  qty: number | null;
  etd: string | null;
  eta: string | null;
  duimp_at: string | null;
  draft_duimp: string | null;
  canal: string | null;
  sefaz_at: string | null;
  nf: string | null;
  delivery_forecast: string | null;
  delivered_at: string | null;
  notes: string | null;
}

export interface NextStep {
  /** Processo (pedido ou embarque) onde a ação acontece. */
  unit: string;
  unit_display: string;
  process_code: string;
  pi_number?: string;
  step_key: string;
  label: string;
  /** Time responsável; sem time = quem observa o pedido. */
  team?: string;
  /** Ação de um clique disponível na tela. */
  action?: string;
  /** Sugerido pela IA a partir das notas da planilha (não vem das regras). */
  ai?: boolean;
}

/** O que a IA leu nas notas livres da planilha. */
export interface AiInsight {
  resumo: string | null;
  atencao: string | null;
  embarques: Record<string, string>;
  pendencias: { texto: string; embarque: string | null; responsavel: string | null }[];
  rastreios: { codigo: string; transportadora: string | null; contexto: string | null }[];
  created_at: string;
  model: string | null;
}

/**
 * Um pedido acompanhado. Antes de embarcar e com um frete só, é o próprio
 * processo (BBI25137). Dividido em mais de um frete, cada frete é um pedido
 * distinto (BBI25205.1, BBI25205.2…).
 */
export interface UnitView {
  /** Identificador interno: o código do processo, ou o da PI (BBI25205-2). */
  unit: string;
  /** Como aparece para as pessoas: BBI25137 ou BBI25205.2. */
  display: string;
  kind: "pedido" | "embarque";
  /** Frete N de M (M > 1 só quando o pedido foi dividido). */
  freight_index: number;
  freight_total: number;
  process_code: string;
  pi_number: string | null;
  order_kind: string;
  /** Título dado no app; quando há, aparece no lugar da descrição e dos produtos. */
  title: string | null;
  description: string | null;
  supplier: string | null;
  category: string | null;
  po_status: string | null;
  /** Produtos deste processo (nomes), para diferenciar os embarques. */
  products: string[];
  steps: StepView[];
  total: number;
  health: Health;
  current: string;
  next_milestone: { label: string; date: string } | null;
  launch_due: string | null;
  launched_at: string | null;
  finalized: boolean;
  situacao: Situacao;
  /** Etapa em que o pedido está agora (a do "Agora"), para o filtro de Seguindo. */
  current_step: string | null;
  /** Quantidade do pedido original que ainda não virou frete. */
  balance_qty: number;
  shipment: ShipmentInfo | null;
  /** Notas de importação deste frete (planilha do fiscal). */
  fiscal: FiscalNoteView[];
  items: ItemView[];
  ai_note: string | null;
  next_steps: NextStep[];
  watching: boolean;
  /** Só em Seguindo: texto do pedido e itens ("SKU · nome · código do fornecedor") para a busca. */
  search?: string;
  search_items?: string[];
}

export interface OrderView {
  process_code: string;
  kind: string;
  /** Título dado no app ao pedido todo (cada frete pode ter o seu em units[].title). */
  title: string | null;
  description: string | null;
  supplier: string | null;
  category: string | null;
  buyer: string | null;
  area: string | null;
  po_status: string | null;
  production_status: string | null;
  qty_total: number | null;
  po_date: string | null;
  files_url: string | null;
  notes: string | null;
  source: string;
  removed_at: string | null;
  /** Cancelado ou on hold no app (vale para o pedido todo, com todos os fretes). */
  hold: HoldView | null;
  /** Etapas do pedido original, antes de qualquer frete (base que os fretes herdam). */
  steps: StepView[];
  /** Pedidos acompanhados: o próprio pedido, ou um por frete quando foi dividido. */
  units: UnitView[];
  /** Itens do pedido original (aba POs por Item). */
  items: ItemView[];
  ai: AiInsight | null;
  /** Amostras do Warehouse Samples (Monday) ligadas a este pedido. */
  samples: SampleView[];
  watchers: string[];
  watching: boolean;
  /** Lançamento do Launches (Monday) ligado a este pedido pela coluna Process. */
  dev: DevInfoView | null;
  /** Outros lançamentos ligados ao mesmo pedido. */
  dev_others: { item_id: string; name: string; url: string | null }[];
  /** Lista de SKUs do pedido (PO do FileMaker, planilha ou lista temporária). */
  skus: SkuListView;
}

/** Tarefa (subelemento) de um lançamento no Monday. */
export interface DevTask {
  name: string;
  status: string | null;
  state: "done" | "doing" | "late" | "blocked" | "todo" | "na";
  owner: string | null;
  start: string | null;
  due: string | null;
  done_at: string | null;
}

/** Lançamento do quadro Launches no Monday: o desenvolvimento do produto antes (e durante) o pedido. */
export interface DevInfoView {
  item_id: string;
  name: string;
  url: string | null;
  board: string;
  /** Grupo do quadro: o mês previsto do lançamento. */
  launch_group: string | null;
  people: string[];
  emails: string[];
  stage: string | null;
  launch_status: string | null;
  sub_stage: string | null;
  tipo: string | null;
  waitlist_col: string | null;
  process_codes: string[];
  /** Tarefas do Monday por etapa da trilha. */
  tasks: Record<string, DevTask[]>;
  /** Tarefas antes da produção que não entram em nenhuma etapa (ex.: moldes). */
  other_tasks: DevTask[];
  /** O que as planilhas de Waitlist/CTR dizem do produto (casado pelo nome, de hora em hora). */
  sheet: DevSheet | null;
}

export interface DevLink {
  label: string;
  url: string;
}

/** Planilhas "Acompanhamento - Waitlist/CTR" e "Dados - Waitlist" para um lançamento. */
export interface DevSheet {
  /** Aba WAITLIST do acompanhamento: situação e links (waitlist, landing page, criativos de CTR). */
  plan: { produto: string; status: string | null; links: DevLink[] } | null;
  /** Aba CTR do acompanhamento: testes A/B/C e situação. */
  ctr: { produto: string; status: string | null; testes: string[]; links: DevLink[] } | null;
  /** Aba Status dos dados da waitlist. */
  status: { produto: string; status: string | null; dias: number | null; inicio: string | null; fim: string | null; cor_atual: string | null; melhor_cor: string | null } | null;
  /** Resultado da waitlist (aba BD, somando os dias de campanha). */
  result: { produto: string; dias: number; investimento: number; leads: number; cliques: number; ctr: number | null; custo_lead: number | null; lead_click: number | null; preco: number | null; ultimo_dia: string | null } | null;
  /** Inscrições por cor (leads da landing page e da Shopify). */
  votes: { produto: string; total: number; cores: { cor: string; n: number; pct: number }[] } | null;
  /** Testes de CTR (anúncios) com o nome do produto. */
  tests: { teste: string; investimento: number | null; ctr: number | null; cpc: number | null; cliques: number | null; status: string | null; data: string | null }[];
}

export interface SkuRow {
  id: number | null;
  code: string | null;
  name: string | null;
  qty: number | null;
  goproduct: boolean;
  goproduct_pk: number | null;
  /** Cor do produto no cadastro do GoProduct. */
  color: string | null;
  color_hex: string | null;
}

export interface SkuListView {
  /** Onde a lista temporária é gravada: o código do pedido ou "dev:<item do Monday>". */
  scope: string;
  source: "po" | "planilha" | "lista" | "manual" | "vazia";
  source_label: string;
  rows: SkuRow[];
  /** Lista temporária (à mão ou lida pela IA): dá para editar até a PO chegar. */
  editable: boolean;
}

/** Um lançamento em desenvolvimento, com a trilha calculada. */
export interface DevProjectView {
  info: DevInfoView;
  steps: StepView[];
  total: number;
  health: Health;
  current: string;
  next_task: (DevTask & { step: string }) | null;
  skus: SkuListView;
  /** Quem está vendo observa este lançamento. */
  watching?: boolean;
  /** Fotos e números da Galeria de Lançamentos. */
  galeria?: GaleriaInfo | null;
}

export interface SampleView {
  item_id: string;
  name: string;
  tracking: string;
  approval: string | null;
  received: string | null;
  url: string | null;
  /** confirmada no app, ligada pela IA (auto) ou sugestão a confirmar (pendente). */
  state: "confirmada" | "auto" | "pendente";
  confidence: number | null;
  evidence: string | null;
}

export interface EventView {
  id: number;
  pi_number: string | null;
  step_key: string | null;
  type: string;
  message: string;
  actor: string;
  created_at: string;
}

export interface NotificationView {
  id: number;
  process_code: string | null;
  pi_number: string | null;
  kind: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
  reason: string | null;
}

/** Um evento da aba Agenda: uma data de um pedido, frete ou desenvolvimento. */
export interface AgendaEvent {
  id: string;
  /** Dia do evento (AAAA-MM-DD). */
  date: string;
  /** logistica (embarque, chegada, desembaraço, entrega), prazo (prazo de uma etapa) ou tarefa (Monday). */
  group: "logistica" | "prazo" | "tarefa";
  track: "desenvolvimento" | "operacao" | "site" | "marketing";
  /** Etapa ou marco (chave), para o filtro. */
  key: string;
  label: string;
  /** Pedido, frete ou lançamento (como aparece para as pessoas). */
  unit: string;
  title: string;
  href: string;
  supplier: string | null;
  /** GOC ou BBI (vazio nos desenvolvimentos). */
  company: string | null;
  state: "done" | "late" | "risk" | "todo";
  /** Data prevista (ainda não aconteceu) ou realizada. */
  forecast: boolean;
  watching: boolean;
  who: string | null;
}

/** Um lançamento na aba Galeria (agrupado pelo mês de lançamento do Monday). */
export interface LaunchCard {
  item_id: string;
  name: string;
  /** Mês de lançamento (AAAA-MM), lido do grupo do item no Monday; null quando o grupo não diz o mês. */
  month: string | null;
  group: string | null;
  board: string;
  stage: string | null;
  launch_status: string | null;
  tipo: string | null;
  people: string[];
  process_codes: string[];
  health: Health;
  total: number;
  current: string;
  /** Linhas de status: o desenvolvimento e, quando já há pedido, Operação, Site e Marketing do pedido. */
  steps: StepView[];
  /** Foto do produto: a primeira escolhida na Galeria de Lançamentos ou, sem ela, a miniatura do GoProduct. */
  img: string | null;
  watching: boolean;
  /** A pessoa está na coluna People do lançamento. */
  mine: boolean;
}

/** Como pintar o quadradinho de uma cor, como no GoProduct: fracionado (cor composta), textura ou cor lisa. */
export interface ColorSwatch {
  hex: string | null;
  /** Hexadecimal de cada pantone (com dois ou mais, o quadradinho é fracionado). */
  hexes?: string[];
  /** Rota do Freeway que serve a miniatura da textura. */
  tex?: string | null;
}

/** O que a Galeria de Lançamentos diz de um lançamento (lido de hora em hora, só leitura). */
export interface GaleriaInfo {
  slug: string;
  nome: string;
  /** Mês de lançamento na Galeria ("nov/2026"). */
  mes: string | null;
  tipo: string | null;
  categoria: string | null;
  subcategoria: string | null;
  /** Status do lançamento na Galeria ("Não Iniciado", "Em andamento", "Lançado"…). */
  status: string | null;
  teste: string | null;
  status_teste: string | null;
  preco: number | null;
  custo: number | null;
  fob: number | null;
  margem: number | null;
  ctr: number | null;
  cpc: number | null;
  custo_lead: number | null;
  lead_click: number | null;
  proj2026: number | null;
  proj2027: number | null;
  rec_estimada: number | null;
  /** Receita projetada por mês (só os meses com valor). */
  receita_mes: { mes: string; valor: number }[];
  /** Fotos escolhidas na Galeria (rotas do Freeway que servem a imagem). */
  fotos: string[];
  comentarios: number;
  /** Como ligou ao lançamento do Monday: pelo link do item (monday) ou pelo nome. */
  via: "monday" | "nome";
}
