import type { DB } from "../env";
import { all, one, todayBR } from "../db/q";
import { addDays, APPROVAL_LABEL, daysBetween, DESTINATION_LABEL, displayPi, fmtDate, fmtQty, itemKey, placeOf, PRODUCTION_STATUS_LABEL, SHIPMENT_STATUS_LABEL, slugsOf } from "../shared/labels";
import type { AiInsight, DevInfoView, FiscalNoteView, Health, HoldView, Situacao, SkuListView, ItemCell, ItemKind, ItemView, NextStep, OrderView, SampleView, ShipmentInfo, StepStatus, StepView, UnitView } from "../shared/types";
import type { FactoryPart } from "./factory";
import { sampleTracking } from "../integrations/monday";
import { GOPRODUCT_SKUS } from "../data/goproduct-skus";
import { STEP_BY_KEY, STEPS, TEAM_LABEL, type StepDef } from "./steps";
import { dueText, step, trackingDelivered, trackingText, withDue } from "./stepkit";
import { buildSkuList, DEV_EDITABLE, DEV_KEYS, devInfosByCode, devSteps, goproductByCode, type SkuDbRow } from "./dev";
import { loadPalette, type Palette } from "./colors";
import { fiscalNoteView } from "../integrations/fiscal";

/** Marcações das etapas editáveis do desenvolvimento: do lançamento, ou do pedido quando não há lançamento. */
function devManualOf(rows: { step_key: string; data: string }[], orderState: Map<string, Record<string, any>> | null): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const r of rows) out[r.step_key] = JSON.parse(r.data);
  if (orderState) for (const k of DEV_EDITABLE) if (orderState.has(k)) out[k] = orderState.get(k)!;
  return out;
}


interface FactoryRow {
  parts: string | null;
  site_checked: number | null;
  checked_at: string;
}

/**
 * Situação do item no site, aparelho por aparelho (uma capa "iPhone 17 Pro / 18 Pro" tem dois):
 * cadastrado = material ativo na fábrica; no site = modelo × aparelho configurado e estoque do site ativo.
 */
interface SiteSignal {
  /** Cadastrado em todos os aparelhos (ou slug na planilha de produtos, enquanto a fábrica não foi consultada). */
  registered: boolean;
  fromSheet: string | null;
  parts: FactoryPart[];
  /** Fábrica consultada para este item. */
  checked: boolean;
  siteChecked: boolean;
  /** No site em todos os aparelhos. */
  onSite: boolean;
  /** No site e, se o pedido tem alinhamento de matriz, alinhamento feito. */
  live: boolean;
  alinhamentoOk: boolean;
}

// Progresso de importação por status do embarque na planilha.
const IMPORT_PROGRESS: Record<string, number> = { pronto: 0.15, booking: 0.35, transito: 0.7 };

interface Ctx {
  order: Record<string, any>;
  shipments: Record<string, any>[];
  shipmentItems: Map<string, Record<string, any>[]>;
  orderItems: Record<string, any>[];
  checks: Map<string, { done_at: string; done_by: string }>;
  /** Industrialização segundo o GDI, por item de frete. */
  gdi: Map<string, { done: number; doing: number; ops: string[] }>;
  /** Marcas por item: "id#cadastro", "id#wms", "id#lancado". */
  marks: Map<string, { done_at: string; done_by: string | null }>;
  /** Planilha de produtos e estoque, pelo código base do item (TX221004), com os slugs preenchidos nela. */
  products: Map<string, { product: NonNullable<ItemView["product"]>; stock: NonNullable<ItemView["stock"]> | null; slugs: string[] }>;
  /** Base da fábrica (lida quando alguém usa o app), pela chave do item: código WMS ou nome. */
  factory: Map<string, FactoryRow>;
  /** Catálogo do GoProduct pelo IPN (código WMS): pk e se tem miniatura. */
  goproduct: Map<string, { pk: number; thumb: boolean }>;
  state: Map<string, Record<string, any>>;
  watchers: string[];
  ai: AiInsight | null;
  /** Pasta do pedido dentro da pasta do FileMaker no Drive (documentação do pedido). */
  docsFolder: { name: string; link: string } | null;
  samples: SampleView[];
  /** Títulos dados no app: pelo código do processo (pedido todo) ou pela PI (um frete). */
  titles: Map<string, string>;
  /** Cancelado ou on hold no app. */
  hold: HoldView | null;
  /** Notas de importação da planilha do fiscal, pela PI do frete. */
  fiscal: Map<string, FiscalNoteView[]>;
  /** Lançamentos do Launches (Monday) ligados ao pedido, o mais recente primeiro. */
  dev: DevInfoView[];
  /** Lista de SKUs (PO do FileMaker, planilha ou lista temporária) com a situação no GoProduct. */
  skus: SkuListView;
  /** Marcações no app das etapas do desenvolvimento (no lançamento "dev:<item>" ou, sem lançamento, no pedido). */
  devManual: Record<string, Record<string, any>>;
  /** Cores do GoProduct pelo nome (quadradinho das cores da PO). */
  palette?: Palette;
  today: string;
}

/**
 * Pedido acompanhado: o pedido antes de embarcar, ou um frete. Com um frete só
 * ele continua aparecendo com o código do pedido; com mais de um, cada frete é
 * um pedido distinto (BBI25205.1, .2…).
 */
interface Unit {
  unit: string;
  display: string;
  kind: "pedido" | "embarque";
  s: Record<string, any> | null;
  index: number;
  total: number;
}

/** Estado de uma etapa: o embarque herda o que foi marcado no pedido até ter valor próprio. */
function stateOf(ctx: Ctx, u: Unit, key: string): { d: Record<string, any>; inherited: boolean } {
  const def = STEP_BY_KEY[key];
  if (u.kind === "embarque" && def?.scope === "unit") {
    const own = ctx.state.get(`${u.unit}#${key}`);
    if (own && Object.keys(own).length) return { d: own, inherited: false };
    const parent = ctx.state.get(key);
    return { d: parent ?? {}, inherited: !!parent && Object.keys(parent).length > 0 };
  }
  return { d: ctx.state.get(key) ?? {}, inherited: false };
}

function sampleApproved(ctx: Ctx): boolean {
  const d = ctx.state.get("amostra") ?? {};
  return d.approval === "aprovado" || d.approval === "aprovado_restricao";
}

function productionStarted(ctx: Ctx): boolean {
  const ps = ctx.order.production_status;
  return ps === "em_producao" || ps === "parcial" || ps === "finalizado" || ctx.shipments.length > 0;
}

// ---------- Etapas do pedido (uma vez por pedido) ----------

function producao(ctx: Ctx): StepView {
  const def = STEP_BY_KEY.producao;
  const d = ctx.state.get("producao") ?? {};
  const o = ctx.order;
  const ps: string | null = o.production_status;
  if (ps === "servico") return step(def, "na", 0, "Serviço (sem produção)", { data: d, source: "planilha" });
  if (ps === "cancelada") return step(def, "na", 0, "Cancelada", { data: d, source: "planilha" });
  const start: string | null = d.start ?? o.prod_start_sheet ?? null;
  const due: string | null = d.due ?? o.prod_end_sheet ?? null;
  if (ps === "finalizado" || d.done_at) {
    return step(def, "done", 1, d.done_at ? `Concluída em ${fmtDate(d.done_at, true)}` : "Finalizada (planilha)", { data: d, due, source: d.done_at ? "manual" : "planilha" });
  }
  let timeRatio = 0;
  if (start && due) {
    const total = Math.max(1, daysBetween(start, due));
    timeRatio = Math.max(0, Math.min(0.95, daysBetween(start, ctx.today) / total));
  }
  const shippedQty = ctx.shipments.reduce((s, x) => s + (x.qty ?? 0), 0);
  const shipRatio = o.qty_total ? Math.min(0.95, shippedQty / o.qty_total) : 0;
  const label = ps ? PRODUCTION_STATUS_LABEL[ps] : start ? "Em produção" : "Sem status";
  let status: StepStatus;
  let progress: number;
  if (ps === "parcial") {
    status = "doing";
    progress = Math.max(0.5, shipRatio, timeRatio);
  } else if (ps === "em_producao" || (start && start <= ctx.today)) {
    status = "doing";
    progress = start && due ? Math.max(0.05, timeRatio) : 0.3;
  } else {
    status = "todo";
    progress = 0;
  }
  status = withDue(status, due, ctx.today);
  const parts = [label];
  if (due) parts.push(dueText(due, ctx.today));
  else parts.push("informar início e prazo");
  return step(def, status, progress, parts.join(" · "), { data: d, due, source: ps ? "planilha" : "manual" });
}

function alinhamento(ctx: Ctx): StepView {
  const def = STEP_BY_KEY.alinhamento;
  const d = ctx.state.get("alinhamento") ?? {};
  if (!d.enabled) return step(def, "na", 0, "Desligado para este pedido", { data: d });
  if (d.done_at) return step(def, "done", 1, `Concluído em ${fmtDate(d.done_at, true)}`, { data: d, source: "manual" });
  const delivered = trackingDelivered(d);
  if (delivered) {
    const due = addDays(delivered, 10);
    let status = withDue("doing", due, ctx.today);
    const sefazDone = ctx.shipments.some((s) => s.sefaz_at);
    if (sefazDone && status === "doing") status = "risk";
    const extra = sefazDone ? " · um embarque já concluiu o desembaraço" : "";
    return step(def, status, 0.6, `Amostras em Extrema desde ${fmtDate(delivered, true)} · ${dueText(due, ctx.today)}${extra}`, { data: d, due, source: "manual" });
  }
  if (d.tracking) return step(def, "doing", 0.3, `20 amostras a caminho de Extrema · ${trackingText(d)}`, { data: d, source: "fedex" });
  return step(def, "todo", 0, "Enviar 20 amostras para Extrema", { data: d });
}

function orderSteps(ctx: Ctx): Record<string, StepView> {
  const prod = producao(ctx);
  const producaoState = ctx.state.get("producao") ?? {};
  const dev = devSteps({
    info: ctx.dev[0] ?? null,
    amostra: ctx.state.get("amostra") ?? {},
    producao: producaoState,
    docsFolder: ctx.docsFolder,
    shipped: ctx.shipments.length > 0,
    started: productionStarted(ctx) || !!producaoState.docs_done_at,
    hasCode: true,
    skus: ctx.skus,
    manual: ctx.devManual,
    palette: ctx.palette,
    today: ctx.today,
  });
  return { ...dev, producao: prod, alinhamento: alinhamento(ctx) };
}

// ---------- Marketing (de cada pedido; o frete herda o que foi marcado antes da divisão) ----------

function filmagem(ctx: Ctx, u: Unit): StepView {
  const def = STEP_BY_KEY.filmagem;
  const { d, inherited } = stateOf(ctx, u, "filmagem");
  const x = { data: d, inherited };
  if (d.na) return step(def, "na", 0, "Não se aplica", x);
  if (d.link || d.done_at) {
    const parts = [d.link && "Vídeos prontos", d.done_at && `Concluída em ${fmtDate(d.done_at, true)}`];
    return step(def, "done", 1, parts.filter(Boolean).join(" · "), { ...x, source: "manual" });
  }
  if (!sampleApproved(ctx)) return step(def, "todo", 0, "Aguardando aprovação da amostra", x);
  if (!d.delivered_at) return step(def, "doing", 0.1, "Entregar as amostras ao time de filmagem", x);
  if (!d.due) return step(def, "doing", 0.3, `Amostras entregues em ${fmtDate(d.delivered_at, true)} · aguardando prazo`, x);
  return step(def, withDue("doing", d.due, ctx.today), 0.5, `Filmando · ${dueText(d.due, ctx.today)}`, { ...x, due: d.due });
}

function estampas(ctx: Ctx, u: Unit): StepView {
  const def = STEP_BY_KEY.estampas;
  const { d, inherited } = stateOf(ctx, u, "estampas");
  const x = { data: d, inherited };
  if (d.na) return step(def, "na", 0, "Não se aplica", x);
  if (d.decision === "nao_precisa") return step(def, "done", 1, "Não precisa de estampas novas", { ...x, source: "manual" });
  if (d.done_at) return step(def, "done", 1, "Estampas prontas", { ...x, source: "manual" });
  if (!sampleApproved(ctx)) return step(def, "todo", 0, "Aguardando aprovação da amostra", x);
  if (!d.notified_at) return step(def, "doing", 0, "Avisar o time de ilustração", x);
  if (!d.decision) return step(def, "doing", 0.2, `Ilustração avisada em ${fmtDate(d.notified_at, true)} · aguardando avaliação`, x);
  return step(def, withDue("doing", d.due, ctx.today), 0.5, ["Criando/adaptando estampas", dueText(d.due, ctx.today)].filter(Boolean).join(" · "), { ...x, due: d.due ?? null });
}

function marketing(ctx: Ctx, u: Unit, film: StepView): StepView {
  const def = STEP_BY_KEY.marketing;
  const { d, inherited } = stateOf(ctx, u, "marketing");
  const x = { data: d, inherited };
  if (d.na) return step(def, "na", 0, "Não se aplica", x);
  if (d.done_at) return step(def, "done", 1, `Concluído em ${fmtDate(d.done_at, true)}`, { ...x, source: "manual" });
  if (film.status !== "done" && film.status !== "na") return step(def, "todo", 0, "Aguardando os vídeos da filmagem", x);
  const from = film.status === "na" ? "Sem filmagem" : film.data?.link ? "Vídeos enviados ao Marketing" : "Filmagem concluída";
  return step(def, withDue("doing", d.due, ctx.today), 0.3, [from, dueText(d.due, ctx.today)].filter(Boolean).join(" · "), { ...x, due: d.due ?? null });
}

// ---------- Etapas de cada pedido acompanhado (antes de embarcar ou um frete) ----------

function logistics(ctx: Ctx, u: Unit): { steps: Record<string, StepView>; items: ItemView[] } {
  const isBBI = ctx.order.kind === "BBI";
  const indDef = STEP_BY_KEY.industrializacao;
  if (u.kind !== "embarque") {
    return {
      steps: {
        importacao: step(STEP_BY_KEY.importacao, "todo", 0, "Aguardando o embarque"),
        sefaz: step(STEP_BY_KEY.sefaz, "todo", 0, ""),
        chegada: step(STEP_BY_KEY.chegada, "todo", 0, ""),
        industrializacao: isBBI ? step(indDef, "todo", 0, "") : step(indDef, "na", 0, "Só para BBI"),
      },
      // Sem itens na planilha ainda: os SKUs da lista (PO do FileMaker ou lista temporária) entram como itens.
      items: ctx.orderItems.length
        ? ctx.orderItems.map((i) => ({
            id: i.id, item_supplier: i.item_supplier, name: i.sku, code: i.sku_code, qty: i.qty, shipped_qty: i.shipped_qty, pending_qty: i.pending_qty,
          }))
        : ctx.skus.rows.map((r, n) => ({
            id: `sku:${r.id ?? `${ctx.order.process_code}:${r.code ?? n}`}`, item_supplier: null, name: r.name, code: r.code, qty: r.qty, origin: ctx.skus.source_label,
          })),
    };
  }

  const s = u.s!;
  const st = s.status as string;
  const label = SHIPMENT_STATUS_LABEL[st] ?? s.status_raw ?? st;
  const pass = st === "agendada" || st === "entregue";
  const arrived = pass || st === "desembaraco";

  // Importação: do embarque na China até a chegada em Santos.
  let imp: StepView;
  const impDef = STEP_BY_KEY.importacao;
  if (st === "on_hold") imp = step(impDef, "blocked", 0.1, "On hold");
  else if (arrived) imp = step(impDef, "done", 1, s.eta ? `Chegou em Santos (ETA ${fmtDate(s.eta, true)})` : "Chegou em Santos", { source: "planilha" });
  else {
    const p = IMPORT_PROGRESS[st] ?? 0;
    const bits = [label];
    if ((st === "transito" || st === "booking") && s.eta) bits.push(`ETA Santos ${fmtDate(s.eta, true)}`);
    imp = step(impDef, p === 0 ? "todo" : "doing", p, bits.join(" · "), { source: "planilha" });
  }

  // Desembaraço: registro da DI/DUIMP, canal e liberação da SEFAZ.
  const sefDef = STEP_BY_KEY.sefaz;
  const sm = ctx.state.get(`${u.unit}#sefaz`) ?? {};
  let sef: StepView;
  if (s.sefaz_at || sm.manual_at) {
    sef = step(sefDef, "done", 1, `Concluído · SEFAZ liberada em ${fmtDate(s.sefaz_at ?? sm.manual_at, true)}`, { data: sm, source: s.sefaz_at ? "planilha" : "manual" });
  } else if (pass) sef = step(sefDef, "done", 1, "Concluído (sem data de liberação na planilha)", { data: sm, source: "planilha" });
  else if (st === "desembaraco") {
    const bits = [s.duimp_at ? `DUIMP registrada em ${fmtDate(s.duimp_at, true)}` : "Aguardando registro da DUIMP"];
    if (s.canal) bits.push(`canal ${s.canal}`);
    bits.push("aguardando liberação da SEFAZ");
    const p = s.duimp_at ? (s.canal ? 0.7 : 0.5) : 0.25;
    sef = step(sefDef, s.canal === "Vermelho" ? "risk" : "doing", p, bits.join(" · "), { data: sm, source: "planilha" });
  } else sef = step(sefDef, "todo", 0, "", { data: sm });

  const cheDef = STEP_BY_KEY.chegada;
  const dest = s.destination ? DESTINATION_LABEL[s.destination] ?? s.destination : null;
  let che: StepView;
  if (st === "entregue") {
    const when = s.delivered_at ? `em ${fmtDate(s.delivered_at, true)}` : s.delivery_forecast ? `(previsão era ${fmtDate(s.delivery_forecast, true)})` : "";
    che = step(cheDef, "done", 1, `Entregue ${when}`.trim(), { source: "planilha" });
  } else if (st === "agendada") {
    che = step(cheDef, "doing", 0.5, `Entrega agendada${dest ? ` em ${dest}` : ""}${s.delivery_forecast ? ` · previsão ${fmtDate(s.delivery_forecast, true)}` : ""}`, { source: "planilha" });
  } else {
    che = step(cheDef, "todo", 0, s.delivery_forecast ? `Previsão ${fmtDate(s.delivery_forecast, true)}` : "");
  }

  const items: ItemView[] = (ctx.shipmentItems.get(u.unit) ?? []).map((i) => {
    const c = ctx.checks.get(i.id);
    return { id: i.id, item_supplier: i.item_supplier, name: i.sku, code: i.sku_code, qty: i.qty, boxes: i.boxes, done_at: c?.done_at ?? null, done_by: c?.done_by ?? null, gdi: ctx.gdi.get(i.id) ?? null };
  });

  let ind: StepView;
  if (!isBBI) ind = step(indDef, "na", 0, "Só para BBI");
  else {
    const im = ctx.state.get(`${u.unit}#industrializacao`) ?? {};
    const total = items.reduce((a, i) => a + (i.qty ?? 0), 0);
    // Peças prontas: o item marcado conta inteiro; senão, o que o GDI já concluiu dele.
    const doneQty = items.reduce((a, i) => a + (i.done_at ? (i.qty ?? 0) : Math.min(i.qty ?? 0, i.gdi?.done ?? 0)), 0);
    const doneCount = items.filter((i) => i.done_at).length;
    const fromGdi = items.some((i) => i.gdi);
    if (im.done_at || (items.length > 0 && doneCount === items.length)) ind = step(indDef, "done", 1, "Concluída", { data: im, source: fromGdi ? "gdi" : "manual" });
    else if (st !== "entregue") ind = step(indDef, "todo", 0, "Começa na chegada", { data: im });
    else if (items.length === 0) ind = step(indDef, "doing", 0, "Itens não informados na planilha", { data: im });
    else {
      const detail = fromGdi ? `${fmtQty(doneQty)} de ${fmtQty(total)} peças industrializadas (GDI) · ${doneCount} de ${items.length} itens concluídos` : `${doneCount} de ${items.length} itens concluídos`;
      ind = step(indDef, "doing", total > 0 ? doneQty / total : doneCount / items.length, detail, { data: im, source: fromGdi ? "gdi" : undefined });
    }
  }
  return { steps: { importacao: imp, sefaz: sef, chegada: che, industrializacao: ind }, items };
}

function arrivalOf(u: Unit): string | null {
  if (u.kind !== "embarque" || u.s!.status !== "entregue") return null;
  return u.s!.delivered_at ?? u.s!.delivery_forecast ?? null;
}

function fci(ctx: Ctx, u: Unit): StepView {
  const def = STEP_BY_KEY.fci;
  const { d, inherited } = stateOf(ctx, u, "fci");
  if (d.na) return step(def, "na", 0, "Não se aplica", { data: d, inherited });
  if (d.done_at) return step(def, "done", 1, `Concluída${d.number ? ` · nº ${d.number}` : ""}`, { data: d, inherited, source: "manual" });
  const arrived = arrivalOf(u);
  if (!arrived) return step(def, "todo", 0, "Começa quando o embarque chegar", { data: d, inherited });
  const days = Math.max(0, daysBetween(arrived, ctx.today));
  const status: StepStatus = days > 10 ? "late" : days > 7 ? "risk" : "doing";
  return step(def, status, Math.min(0.9, days / 10), `Em andamento há ${days} dia${days === 1 ? "" : "s"} (leva 7 a 10)`, { data: d, inherited, due: addDays(arrived, 10) });
}

function isClosed(d: Record<string, any>): boolean {
  return !!(d.done_at || d.na);
}

function manualStep(ctx: Ctx, u: Unit, def: StepDef): StepView {
  const { d, inherited } = stateOf(ctx, u, def.key);
  if (d.na) return step(def, "na", 0, "Não se aplica", { data: d, inherited });
  if (d.done_at) return step(def, "done", 1, `Concluído em ${fmtDate(d.done_at, true)}`, { data: d, inherited, source: "manual" });
  if (def.after && !isClosed(stateOf(ctx, u, def.after).d)) {
    return step(def, "todo", 0, `Aguardando ${STEP_BY_KEY[def.after].label.toLowerCase()}`, { data: d, inherited });
  }
  const status = withDue(d.started_at || def.after ? "doing" : "todo", d.due, ctx.today);
  const detail = [def.after ? "Liberado" : d.started_at ? "Em andamento" : "Não iniciado", dueText(d.due, ctx.today)].filter(Boolean).join(" · ");
  return step(def, status, def.after ? 0.1 : d.started_at ? 0.4 : 0, detail, { data: d, inherited, due: d.due ?? null });
}

/**
 * Etapa que segue os itens (cadastro no site, cadastro no WMS): concluída quando todos estão feitos,
 * pela marcação à mão ou pela fonte automática; parcial ("X de N itens") quando falta algum.
 */
function coverageStep(key: string, items: ItemView[], manual: StepView, isDone: (i: ItemView) => boolean, noun: [string, string], source: string): StepView {
  if (manual.status === "done" || manual.status === "na" || !items.length) return manual;
  const ok = items.filter(isDone).length;
  if (!ok) return manual;
  const n = items.length;
  if (ok === n) return step(STEP_BY_KEY[key], "done", 1, n === 1 ? `Item ${noun[0]}` : `Os ${n} itens ${noun[1]}`, { data: manual.data, source });
  return {
    ...manual,
    status: manual.status === "todo" ? "doing" : manual.status,
    progress: Math.max(manual.progress, (ok / n) * 0.9),
    detail: [`${ok} de ${n} itens ${noun[1]}`, manual.detail].filter(Boolean).join(" · "),
  };
}

/** Cadastro na fábrica e presença no site de cada aparelho do item (ou o slug da planilha de produtos, antes da consulta). */
function siteSignal(ctx: Ctx, i: ItemView, alinhamentoOk: boolean): SiteSignal {
  const f = ctx.factory.get(itemKey(i.code, i.name) ?? "");
  const parts: FactoryPart[] = f?.parts ? JSON.parse(f.parts) : [];
  const checked = parts.length > 0;
  const sheet = i.code ? ctx.products.get(i.code)?.slugs ?? [] : [];
  const siteChecked = checked && !!f?.site_checked;
  const onSite = siteChecked && parts.every((p) => p.site);
  return {
    registered: checked ? parts.every((p) => p.slug) : sheet.length > 0,
    fromSheet: !checked && sheet.length ? sheet[0] : null,
    parts, checked, siteChecked, onSite,
    live: onSite && alinhamentoOk,
    alinhamentoOk,
  };
}

/**
 * Lançamento: à mão, ou sozinho quando todos os itens do frete estão no ar (cadastrados, com saldo
 * pronto em Extrema e, se o pedido tem alinhamento de matriz, alinhamento feito) e o frete já chegou —
 * antes disso, saldo em Extrema é de um lote anterior. Reaberto à mão depois de marcado sozinho, vale o manual.
 */
function lancamento(ctx: Ctx, u: Unit, by: Record<string, StepView>, items: ItemView[], sig: Map<string, SiteSignal>, arrived: boolean): StepView {
  const def = STEP_BY_KEY.lancamento;
  const { d, inherited } = stateOf(ctx, u, "lancamento");
  if (d.done_at) return step(def, "done", 1, `Lançado no site em ${fmtDate(d.done_at)}`, { data: d, inherited, source: d.auto_at ? "fabrica-gravado" : "manual" });
  const autoLive = (i: ItemView) => !!sig.get(i.id)?.live && arrived;
  const live = items.filter((i) => ctx.marks.has(`${i.id}#lancado`) || autoLive(i)).length;
  if (items.length && live === items.length && items.some(autoLive) && !d.auto_at) {
    return step(def, "done", 1, "No ar: itens cadastrados e com saldo em Extrema", { data: d, inherited, source: "fabrica" });
  }
  const ready = ["mockups", "cadastro_site", "cadastro_wms"].every((k) => by[k].status === "done" || by[k].status === "na");
  const share = items.length ? live / items.length : 0;
  const liveText = live ? `${live} de ${items.length} itens no ar` : "";
  if (!d.due) {
    return step(def, live ? "doing" : "todo", share * 0.9, [ready ? "Pronto para lançar · informar a data" : "Informar a data de lançamento", liveText].filter(Boolean).join(" · "), { data: d, inherited });
  }
  const status = withDue(ready || live ? "doing" : "todo", d.due, ctx.today);
  return step(def, status, Math.max(ready ? 0.5 : 0, share * 0.9), [`Previsto para ${fmtDate(d.due)}${ready ? " · cadastros prontos" : ""}`, liveText].filter(Boolean).join(" · "), { data: d, inherited, due: d.due });
}

// ---------- Montagem ----------

function healthOf(steps: StepView[]): Health {
  if (steps.some((s) => s.status === "late" || s.status === "blocked")) return "late";
  if (steps.some((s) => s.status === "risk")) return "risk";
  return "ok";
}

function balanceOf(ctx: Ctx): number {
  const o = ctx.order;
  if (o.po_status === "Finalizada" || o.po_status === "Cancelada") return 0;
  const shipped = ctx.shipments.reduce((a, s) => a + (s.qty ?? 0), 0);
  return Math.max(0, (o.qty_total ?? 0) - shipped);
}

function shipmentInfo(s: Record<string, any>): ShipmentInfo {
  return {
    status: s.status,
    status_label: SHIPMENT_STATUS_LABEL[s.status] ?? s.status_raw ?? s.status,
    destination: s.destination,
    modal: s.modal,
    trader: s.trader,
    carrier_line: s.carrier_line,
    ref_bl: s.ref_bl,
    qty: s.qty,
    etd: s.etd,
    eta: s.eta,
    duimp_at: s.duimp_at,
    draft_duimp: s.draft_duimp,
    canal: s.canal,
    sefaz_at: s.sefaz_at,
    nf: s.nf,
    delivery_forecast: s.delivery_forecast,
    delivered_at: s.delivered_at,
    notes: s.notes,
  };
}

function nextStep(ctx: Ctx, u: { unit: string; display: string; pi?: string }, n: Omit<NextStep, "unit" | "unit_display" | "process_code" | "pi_number">): NextStep {
  return { unit: u.unit, unit_display: u.display, process_code: ctx.order.process_code, pi_number: u.pi, ...n };
}

type NewStep = Omit<NextStep, "unit" | "unit_display" | "process_code" | "pi_number">;

function refOf(u: Unit) {
  return { unit: u.unit, display: u.display, pi: u.kind === "embarque" ? u.unit : undefined };
}

/**
 * Próximos passos do pedido original (amostra, produção, alinhamento). Aparecem
 * uma vez só, no primeiro pedido em aberto, mesmo quando ele foi dividido em fretes.
 */
function orderNextSteps(ctx: Ctx, os: Record<string, StepView>, u: Unit, units: Unit[]): NextStep[] {
  const out: NextStep[] = [];
  const add = (n: NewStep) => out.push(nextStep(ctx, refOf(u), n));
  const amostraD = ctx.state.get("amostra") ?? {};
  const open = (s: StepView) => s.status !== "done" && s.status !== "na";
  // Desenvolvimento: amostra → validação → lista de SKUs no GoProduct → documentação → prazo da produção.
  if (os.amostra.status === "todo" && !open(os.amostra_fab)) add({ step_key: "amostra", label: "Informar o rastreio FedEx da amostra" });
  if (os.amostra_validacao.status === "doing" && trackingDelivered(amostraD)) add({ step_key: "amostra_validacao", label: "Registrar a aprovação da amostra" });
  const validated = !open(os.amostra_validacao);
  // Cadastro no GoProduct só cobra antes da documentação (depois dela, a PO já saiu com os SKUs).
  if (u.kind === "pedido" && validated && open(os.goproduct) && open(os.documentacao) && os.producao.status === "todo") {
    add({ step_key: "goproduct", label: ctx.skus.rows.length ? "Cadastrar no GoProduct os SKUs que faltam" : "Informar a lista de SKUs do pedido" });
  }
  if (u.kind === "pedido" && validated && open(os.documentacao)) {
    add({ step_key: "documentacao", label: "Enviar a documentação do pedido (PO, carton marks, barcodes)", action: "docs_prontos" });
  }
  if (u.kind === "pedido" && open(os.producao) && !os.producao.due && (!open(os.documentacao) || os.producao.status !== "todo")) {
    add({ step_key: "producao", label: "Informar o prazo de conclusão da produção" });
  }
  for (const s of ctx.samples) {
    if (s.state === "pendente") add({ step_key: "amostra", label: `Confirmar se a amostra ${s.tracking || s.name} é deste pedido` });
  }

  const al = os.alinhamento;
  const alD = ctx.state.get("alinhamento") ?? {};
  if (al.status !== "na" && al.status !== "done") {
    if (!alD.tracking && !trackingDelivered(alD)) add({ step_key: "alinhamento", label: "Informar o rastreio das 20 amostras para Extrema" });
    else if (trackingDelivered(alD)) add({ step_key: "alinhamento", label: `Concluir o alinhamento de matriz (${dueText(al.due, ctx.today)})` });
  }

  // Pendências da IA que não citam um frete deste pedido.
  for (const p of ctx.ai?.pendencias ?? []) {
    if (p.embarque && units.some((x) => x.display === p.embarque)) continue;
    add({ step_key: "notas", label: p.texto, team: p.responsavel && TEAM_LABEL[p.responsavel] ? p.responsavel : undefined, ai: true });
  }
  return out;
}

/** Próximos passos de um pedido acompanhado (o pedido inteiro ou um frete). */
function unitNextSteps(ctx: Ctx, u: Unit, by: Record<string, StepView>): NextStep[] {
  const out: NextStep[] = [];
  const add = (n: NewStep) => out.push(nextStep(ctx, refOf(u), n));

  if (sampleApproved(ctx)) {
    const es = stateOf(ctx, u, "estampas").d;
    if (by.estampas.status !== "done" && by.estampas.status !== "na") {
      if (!es.notified_at) add({ step_key: "estampas", label: "Avisar o time de ilustração", action: "notify_ilustracao" });
      else if (!es.decision) add({ step_key: "estampas", label: "Avaliar se precisa criar ou adaptar estampas", team: "ilustracao" });
      else if (es.decision === "precisa") add({ step_key: "estampas", label: "Concluir as estampas", team: "ilustracao" });
    }
    const fi = stateOf(ctx, u, "filmagem").d;
    if (by.filmagem.status !== "done" && by.filmagem.status !== "na") {
      if (!fi.delivered_at) add({ step_key: "filmagem", label: "Entregar as amostras ao time de filmagem", action: "filmagem_entregue" });
      else if (!fi.due) add({ step_key: "filmagem", label: "Informar o prazo da filmagem", team: "filmagem" });
      else add({ step_key: "filmagem", label: "Enviar o link dos vídeos", team: "filmagem" });
    }
  }
  if (!["todo", "done", "na"].includes(by.marketing.status)) add({ step_key: "marketing", label: "Concluir o marketing do produto", team: "marketing" });

  if (!["todo", "done", "na"].includes(by.fci.status)) add({ step_key: "fci", label: "Anexar a FCI" });
  const ind = by.industrializacao;
  if (u.kind === "embarque" && (ind.status === "doing" || ind.status === "risk")) {
    add({ step_key: "industrializacao", label: "Marcar os itens industrializados", team: "itapeva" });
  }

  // A trilha Site só cobra depois que o produto chegou ou quando já há data de lançamento.
  if (by.chegada.status === "done" || by.lancamento.due) {
    for (const key of ["mockups", "cadastro_site", "cadastro_wms"]) {
      const def = STEP_BY_KEY[key];
      const v = by[key];
      if (v.status === "doing" || v.status === "risk" || v.status === "late" || (v.status === "todo" && !def.after)) {
        add({ step_key: key, label: def.nextLabel ?? `Concluir ${def.label.toLowerCase()}`, team: def.team });
      }
    }
    if (by.lancamento.status !== "done" && !by.lancamento.due) add({ step_key: "lancamento", label: "Informar a data de lançamento" });
    else if (by.lancamento.status === "doing" || by.lancamento.status === "risk" || by.lancamento.status === "late") {
      add({ step_key: "lancamento", label: "Marcar o lançamento no site", team: "ecommerce" });
    }
  }

  for (const p of ctx.ai?.pendencias ?? []) {
    if (p.embarque !== u.display) continue;
    add({ step_key: "notas", label: p.texto, team: p.responsavel && TEAM_LABEL[p.responsavel] ? p.responsavel : undefined, ai: true });
  }
  return out;
}

// Frentes por item e a etapa do frete que vale para todos os itens quando concluída.
const ITEM_STEPS: Record<Exclude<ItemKind, "industrializacao">, string> = { fci: "fci", cadastro: "cadastro_site", wms: "cadastro_wms", lancado: "lancamento" };

/**
 * Situação de cada item (SKU) em cada frente, para a lista de produtos:
 * industrialização pelo item marcado ou pelo GDI (com % de peças); cadastro,
 * WMS e lançamento pelo item marcado à mão ou pela etapa do frete concluída.
 */
let pkByIpn: Map<string, number> | null = null;
/** pk do produto no GoProduct pelo IPN (= código WMS do item); com IPN repetido, vale o primeiro. */
function goproductPk(): Map<string, number> {
  if (!pkByIpn) {
    pkByIpn = new Map();
    for (const [ipn, , pk] of GOPRODUCT_SKUS) if (!pkByIpn.has(ipn)) pkByIpn.set(ipn, pk);
  }
  return pkByIpn;
}

/** Célula de cadastro no site e de lançamento pela fábrica; null quando ela não diz nada (vale a etapa). */
function siteCell(kind: "cadastro" | "lancado", s: SiteSignal | undefined, arrived: boolean, st: StepView | undefined): ItemCell | null {
  if (!s) return null;
  const n = s.parts.length;
  const multi = n > 1;
  const labels = (ps: FactoryPart[]) => ps.map((p) => p.label).join(", ");
  const slugs = (ps: FactoryPart[]) => ps.map((p) => p.slug).filter(Boolean).join(", ");
  if (kind === "cadastro") {
    if (!s.checked) return s.fromSheet ? { state: "done", detail: `Slug ${s.fromSheet} na planilha de produtos` } : null;
    const ok = s.parts.filter((p) => p.slug);
    const miss = s.parts.filter((p) => !p.slug);
    if (!miss.length) {
      const when = !multi && ok[0].created_at ? ` em ${fmtDate(ok[0].created_at, true)}` : "";
      return { state: "done", detail: `Cadastrado na fábrica${multi ? ` para ${labels(ok)}` : when} · ${slugs(ok)}` };
    }
    if (ok.length) return { state: "doing", pct: ok.length / n, detail: `Cadastrado para ${labels(ok)} (${slugs(ok)}) · falta ${labels(miss)}` };
    if (st?.status === "done" || st?.status === "na") return null;
    return { state: st && st.status !== "todo" ? "doing" : "todo", pct: 0, detail: "Ainda sem cadastro (slug) na fábrica" };
  }
  if (st?.status === "done") return null;
  if (!s.checked) return s.fromSheet ? { state: "todo", detail: "Cadastrado · site ainda não consultado" } : null;
  if (!s.parts.some((p) => p.slug)) return null;
  if (!s.siteChecked) return { state: "todo", detail: "Não foi possível consultar o site" };
  const qty = s.parts.reduce((a, p) => a + p.extrema, 0);
  const ext = qty ? ` · ${fmtQty(qty)} prontas em Extrema` : "";
  const on = s.parts.filter((p) => p.site);
  const off = s.parts.filter((p) => !p.site);
  if (!off.length) {
    if (!s.alinhamentoOk) return { state: "doing", pct: 0.8, detail: "No site, mas o alinhamento de matriz ainda não foi concluído" };
    if (arrived) return { state: "done", detail: `No site${multi ? ` para ${labels(on)}` : ""}${ext}` };
    return { state: "doing", pct: 0.5, detail: "Já está no site (lote anterior) · este frete ainda não chegou" };
  }
  const why = off.map((p) => `${multi ? `${p.label}: ` : ""}${p.why ?? "fora do site"}`).join(" · ");
  if (on.length) return { state: "doing", pct: on.length / n, detail: `No site para ${labels(on)} · ${why}` };
  return { state: "todo", detail: `Ainda não está no site: ${why}${ext}` };
}

function withItemStatus(ctx: Ctx, u: Unit, items: ItemView[], by: Record<string, StepView>, sig: Map<string, SiteSignal>, arrived: boolean): void {
  const marked = (id: string, kind: string) => ctx.marks.get(`${id}#${kind}`);
  const isBBI = ctx.order.kind === "BBI";
  for (const i of items) {
    const qty = i.qty ?? 0;
    const info = i.code ? ctx.products.get(i.code) : undefined;
    i.product = info?.product ?? null;
    const gp = i.code ? ctx.goproduct.get(i.code.toUpperCase()) : undefined;
    i.goproduct = gp?.pk ?? (i.code ? goproductPk().get(i.code.toUpperCase()) ?? null : null);
    i.goproduct_img = gp?.thumb ? `/api/goproduct/img/${gp.pk}` : null;
    i.stock = info?.stock ?? null;
    let ind: ItemCell;
    if (!isBBI) ind = { state: "na", detail: "Só para BBI" };
    else if (u.kind !== "embarque") ind = { state: "todo", detail: "Começa quando o frete chegar a Itapeva" };
    else if (i.done_at) ind = { state: "done", detail: `Industrializado em ${fmtDate(i.done_at, true)}${i.done_by ? ` · ${i.done_by}` : ""}` };
    else if (i.gdi && (i.gdi.done > 0 || i.gdi.doing > 0)) {
      const pct = qty ? Math.min(1, i.gdi.done / qty) : 0;
      ind = { state: "doing", pct, detail: `${fmtQty(Math.min(i.gdi.done, qty))} de ${fmtQty(qty)} peças no GDI${i.gdi.doing ? ` · ${fmtQty(i.gdi.doing)} em OP aberta` : ""}` };
    } else ind = { state: "todo", detail: u.s?.status === "entregue" ? "Aguardando a industrialização" : "Aguardando a chegada a Itapeva" };

    const cells = { industrializacao: ind } as Record<ItemKind, ItemCell>;
    for (const [kind, stepKey] of Object.entries(ITEM_STEPS) as [Exclude<ItemKind, "industrializacao">, string][]) {
      const m = marked(i.id, kind);
      const st = by[stepKey];
      const share = items.length ? items.filter((x) => marked(x.id, kind)).length / items.length : 0;
      const s = sig.get(i.id);
      const auto = kind === "cadastro" || kind === "lancado" ? siteCell(kind, s, arrived, st) : null;
      if (m) cells[kind] = { state: "done", marked: true, detail: `Marcado em ${fmtDate(m.done_at, true)}${m.done_by ? ` · ${m.done_by}` : ""}` };
      else if (kind === "wms" && info) cells[kind] = { state: "done", detail: `Cadastrado no WMS (${i.code} e variações, pela planilha de produtos)` };
      else if (auto) cells[kind] = auto;
      else if (st?.status === "na") cells[kind] = { state: "na", detail: "Não se aplica" };
      else if (st?.status === "done") cells[kind] = { state: "done", detail: `${st.label} concluído para o frete` };
      else if (st && st.status !== "todo") cells[kind] = { state: "doing", pct: share, detail: `${st.label} em andamento · ${Math.round(share * 100)}% dos itens marcados` };
      else cells[kind] = { state: "todo", detail: st?.detail?.startsWith("Aguardando") ? st.detail : `${st?.label ?? kind}: aguardando` };
    }
    i.status = cells;
  }
}

const SHIPPED_STATUS = new Set(["transito", "desembaraco", "agendada", "entregue"]);

function freightProduction(s: Record<string, any>): StepView {
  const def = STEP_BY_KEY.producao;
  if (SHIPPED_STATUS.has(s.status)) return step(def, "done", 1, s.etd ? `Embarcado (ETD ${fmtDate(s.etd, true)})` : "Embarcado", { source: "planilha" });
  const label = s.status === "desconhecido" ? null : SHIPMENT_STATUS_LABEL[s.status] ?? s.status_raw ?? null;
  return step(def, "done", 1, ["Produção concluída", label].filter(Boolean).join(" · "), { source: "planilha" });
}

function buildUnit(ctx: Ctx, u: Unit, os: Record<string, StepView>): UnitView {
  const { steps: log, items } = logistics(ctx, u);
  const by: Record<string, StepView> = { ...log };
  // Desenvolvimento, amostra e alinhamento são do pedido original: todos os fretes mostram o mesmo.
  for (const k of DEV_KEYS) by[k] = os[k];
  by.alinhamento = os.alinhamento;
  by.fci = fci(ctx, u);
  for (const key of ["mockups", "cadastro_site", "cadastro_wms"]) by[key] = manualStep(ctx, u, STEP_BY_KEY[key]);
  // Site: cada item cadastrado (slug na fábrica ou na planilha de produtos), no WMS (de-para) e no ar.
  const alinhamentoOk = by.alinhamento.status === "done" || by.alinhamento.status === "na";
  const sig = new Map(items.map((i) => [i.id, siteSignal(ctx, i, alinhamentoOk)]));
  const arrived = by.chegada.status === "done";
  by.cadastro_site = coverageStep("cadastro_site", items, by.cadastro_site, (i) => ctx.marks.has(`${i.id}#cadastro`) || !!sig.get(i.id)?.registered, ["cadastrado no site", "cadastrados no site"], "fabrica");
  // FCI é por produto: marcada item a item na lista; todos marcados = etapa concluída.
  by.fci = coverageStep("fci", items, by.fci, (i) => ctx.marks.has(`${i.id}#fci`), ["com FCI", "com FCI"], "manual");
  by.cadastro_wms = coverageStep("cadastro_wms", items, by.cadastro_wms, (i) => ctx.marks.has(`${i.id}#wms`) || !!(i.code && ctx.products.has(i.code)), ["cadastrado no WMS", "cadastrados no WMS"], "produtos");
  by.lancamento = lancamento(ctx, u, by, items, sig, arrived);
  by.filmagem = filmagem(ctx, u);
  by.estampas = estampas(ctx, u);
  by.marketing = marketing(ctx, u, by.filmagem);
  // Num frete a produção daquele lote acabou. "Embarcado" só depois que ele sai (em trânsito ou depois);
  // pronto para embarque, booking ou on hold ainda não embarcaram.
  by.producao = u.kind === "embarque" ? freightProduction(u.s!) : os.producao;

  const steps = STEPS.map((d) => by[d.key]);
  const applicable = steps.filter((s) => s.status !== "na");
  const wsum = applicable.reduce((a, s) => a + STEP_BY_KEY[s.key].weight, 0) || 1;
  const total = applicable.reduce((a, s) => a + s.progress * STEP_BY_KEY[s.key].weight, 0) / wsum;
  const launched = by.lancamento.status === "done";

  // Com a produção andando, o "agora" é da operação (o que sobrou do desenvolvimento não segura o pedido).
  const devOver = by.producao.status !== "todo";
  const flow = steps.filter((s) => s.track !== "marketing" && !(devOver && s.track === "desenvolvimento") && s.status !== "na" && s.status !== "done");
  // Cancelado (no app ou na planilha) e on hold no app param o pedido: sem próximos passos nem cobranças.
  const hold = ctx.hold;
  const cancelled = hold?.state === "cancelado" || ctx.order.po_status === "Cancelada";
  const situacao: Situacao = cancelled ? "cancelado" : launched ? "lancado" : hold?.state === "on_hold" || u.s?.status === "on_hold" ? "on_hold" : "andamento";
  const stopped = cancelled || (hold?.state === "on_hold" && !launched);
  const holdNote = hold?.note ? `: ${hold.note}` : "";
  const current = cancelled
    ? `Cancelado${hold?.state === "cancelado" ? holdNote : ""}`
    : launched
      ? by.lancamento.detail
      : stopped
        ? `On hold${holdNote}`
        : flow.length
          ? `${flow[0].label}${flow[0].detail ? `: ${flow[0].detail}` : ""}`
          : "Pronto para lançar";

  const milestones: { label: string; date: string }[] = [];
  for (const s of steps) if (s.due && s.status !== "done" && s.status !== "na") milestones.push({ label: s.label, date: s.due });
  if (u.kind === "embarque") {
    const s = u.s!;
    if ((s.status === "transito" || s.status === "booking") && s.eta) milestones.push({ label: "ETA Santos", date: s.eta });
    if (s.status === "agendada" && s.delivery_forecast) milestones.push({ label: "Entrega", date: s.delivery_forecast });
  }
  milestones.sort((a, b) => a.date.localeCompare(b.date));
  const next_milestone = launched || stopped ? null : milestones.find((m) => m.date >= ctx.today) ?? milestones[0] ?? null;

  const names = [...new Set(items.map((i) => i.name ?? i.item_supplier).filter(Boolean) as string[])];
  withItemStatus(ctx, u, items, by, sig, arrived);
  return {
    unit: u.unit,
    display: u.display,
    kind: u.kind,
    freight_index: u.index,
    freight_total: u.total,
    process_code: ctx.order.process_code,
    pi_number: u.kind === "embarque" ? u.unit : null,
    order_kind: ctx.order.kind,
    title: (u.total > 1 ? ctx.titles.get(u.unit) : undefined) ?? ctx.titles.get(ctx.order.process_code) ?? null,
    description: ctx.order.description,
    supplier: ctx.order.supplier,
    category: ctx.order.category,
    po_status: ctx.order.po_status,
    products: names,
    steps,
    // Lançado no site = processo finalizado.
    total: launched ? 1 : total,
    health: launched ? "ok" : healthOf(applicable),
    current,
    next_milestone,
    launch_due: by.lancamento.data?.due ?? null,
    launched_at: by.lancamento.data?.done_at ?? null,
    finalized: launched,
    situacao,
    current_step: launched ? "lancamento" : flow[0]?.key ?? null,
    balance_qty: balanceOf(ctx),
    shipment: u.kind === "embarque" ? shipmentInfo(u.s!) : null,
    fiscal: u.kind === "embarque" ? ctx.fiscal.get(u.unit) ?? [] : [],
    items,
    // Num pedido com um frete só, a situação do frete e o resumo do pedido são a mesma coisa.
    ai_note:
      u.total > 1
        ? u.s!.status === "entregue" ? null : ctx.ai?.embarques?.[u.display] ?? null
        : ctx.ai?.embarques?.[u.display] ?? ctx.ai?.resumo ?? null,
    next_steps: launched || stopped ? [] : unitNextSteps(ctx, u, by),
    watching: false,
  };
}

function compute(ctx: Ctx): OrderView {
  const o = ctx.order;
  const os = orderSteps(ctx);
  const code = o.process_code as string;
  const n = ctx.shipments.length;
  // Sem frete ainda: o próprio pedido. Com um frete: o frete, com o código do pedido.
  // Com mais de um: cada frete é um pedido distinto (BBI25205.1, .2…).
  const base: Unit = { unit: code, display: code, kind: "pedido", s: null, index: 1, total: 1 };
  const units: Unit[] =
    n === 0
      ? [base]
      : ctx.shipments.map((s, i) => ({ unit: s.pi_number, display: n === 1 ? code : displayPi(s.pi_number), kind: "embarque" as const, s, index: i + 1, total: n }));
  const unitViews = units.map((u) => buildUnit(ctx, u, os));
  // O que foi marcado antes da divisão (base que os fretes herdam).
  const baseView = n === 0 ? unitViews[0] : buildUnit(ctx, base, os);
  // Etapas do pedido original aparecem uma vez, no primeiro pedido ainda em aberto.
  const primary = Math.max(0, unitViews.findIndex((u) => !u.finalized));
  const stopped = !!ctx.hold || o.po_status === "Cancelada";
  if (!unitViews[primary].finalized && !stopped) unitViews[primary].next_steps.unshift(...orderNextSteps(ctx, os, units[primary], units));

  return {
    process_code: code,
    kind: o.kind,
    title: ctx.titles.get(code) ?? null,
    description: o.description,
    supplier: o.supplier,
    category: o.category,
    buyer: o.buyer,
    area: o.area,
    po_status: o.po_status,
    production_status: o.production_status,
    qty_total: o.qty_total,
    po_date: o.po_date,
    files_url: o.files_url,
    notes: o.notes,
    source: o.source,
    removed_at: o.removed_at,
    hold: ctx.hold,
    steps: baseView.steps,
    units: unitViews,
    items: baseView.items,
    ai: ctx.ai,
    samples: ctx.samples,
    watchers: ctx.watchers,
    watching: false,
    dev: ctx.dev[0] ?? null,
    dev_others: ctx.dev.slice(1).map((d) => ({ item_id: d.item_id, name: d.name, url: d.url })),
    skus: ctx.skus,
  };
}

/** Cadastro (planilha de produtos) e saldo no WMS de cada código base, somando as variações do código. */
async function loadProducts(db: DB, codes: string[]): Promise<Ctx["products"]> {
  const out: Ctx["products"] = new Map();
  if (!codes.length) return out;
  const p = [JSON.stringify(codes)];
  const [prods, stock, names] = await Promise.all([
    all(db, `SELECT base_code, sku_unico, status, origem, factory FROM product_codes WHERE base_code IN (SELECT value FROM json_each(?))`, p),
    all(db, `SELECT base_code, codigo, armazem, saldo_total FROM wms_stock WHERE base_code IN (SELECT value FROM json_each(?)) AND saldo_total <> 0`, p),
    one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'wms_armazens'`),
  ]);
  const armazens: Record<string, string> = names ? JSON.parse(names.value).armazens ?? {} : {};
  const stockBy = new Map<string, NonNullable<ItemView["stock"]>>();
  for (const s of stock) {
    const st = stockBy.get(s.base_code) ?? { itapeva: 0, extrema: 0, linhares: 0, outros: 0, detail: [] };
    const place = placeOf(s.armazem, armazens);
    const qty = Number(s.saldo_total) || 0;
    if (place === "Itapeva") st.itapeva += qty;
    else if (place === "Extrema") st.extrema += qty;
    else if (place === "Linhares") st.linhares += qty;
    else st.outros += qty;
    st.detail.push(`${s.codigo} · ${armazens[s.armazem] ?? s.armazem}: ${fmtQty(qty)}`);
    stockBy.set(s.base_code, st);
  }
  for (const r of prods) {
    out.set(r.base_code, { product: { sku_unico: r.sku_unico ?? null, status: r.status ?? null, origem: r.origem ?? null }, stock: stockBy.get(r.base_code) ?? null, slugs: slugsOf(r.factory) });
  }
  return out;
}

/** Carrega e calcula a visão completa de vários pedidos de uma vez. */
export async function loadViews(db: DB, codes: string[], viewer?: string): Promise<OrderView[]> {
  if (!codes.length) return [];
  const p = [JSON.stringify(codes)];
  const IN = `IN (SELECT value FROM json_each(?))`;
  const [orders, shipments, sitems, oitems, states, watchers, insights, docFolders, sampleRows, titleRows] = await Promise.all([
    all(db, `SELECT * FROM orders WHERE process_code ${IN}`, p),
    all(db, `SELECT * FROM shipments WHERE removed_at IS NULL AND process_code ${IN} ORDER BY seq`, p),
    all(db, `SELECT id, pi_number, process_code, item_supplier, sku, sku_code, qty, boxes FROM shipment_items WHERE removed_at IS NULL AND process_code ${IN} ORDER BY id`, p),
    all(db, `SELECT id, process_code, item_supplier, sku, sku_code, qty, shipped_qty, pending_qty FROM order_items WHERE removed_at IS NULL AND process_code ${IN} ORDER BY id`, p),
    all(db, `SELECT scope, step_key, data FROM step_state WHERE scope ${IN} OR substr(scope, 1, 8) ${IN}`, [p[0], p[0]]),
    all(db, `SELECT process_code, user_email FROM watchers WHERE process_code ${IN} ORDER BY created_at`, p),
    all(db, `SELECT process_code, result, model, created_at FROM ai_insights WHERE result IS NOT NULL AND process_code ${IN}`, p),
    all(db, `SELECT process_code, folder_name, link FROM order_docs WHERE process_code ${IN}`, p),
    all(
      db,
      `SELECT j.value AS process_code, l.item_id, l.status, l.confirmed, l.confidence, l.evidence, m.name, m.vals, m.url
         FROM sample_links l JOIN json_each(l.process_codes) j JOIN monday_items m ON m.item_id = l.item_id
        WHERE j.value ${IN}
        ORDER BY m.updated_at DESC`,
      p,
    ),
    all(db, `SELECT unit, process_code, title FROM unit_titles WHERE process_code ${IN}`, p),
  ]);
  const docsBy = new Map(docFolders.map((r) => [r.process_code as string, { name: r.folder_name as string, link: r.link as string }]));
  // Notas de importação ligadas aos fretes destes pedidos.
  const fiscalBy = new Map<string, FiscalNoteView[]>();
  const piList = shipments.map((s) => s.pi_number as string);
  if (piList.length) {
    const rows = await all(
      db,
      `SELECT f.data, f.via, f.updated_at, j.value AS pi FROM fiscal_notes f, json_each(f.pis) j WHERE j.value IN (SELECT value FROM json_each(?)) ORDER BY f.processo`,
      [JSON.stringify(piList)],
    );
    for (const r of rows) fiscalBy.set(r.pi, [...(fiscalBy.get(r.pi) ?? []), fiscalNoteView(r.data, r.via ?? null, r.updated_at ?? null)]);
  }
  const holdBy = new Map<string, HoldView>(
    (await all(db, `SELECT process_code, state, note, updated_by, updated_at FROM order_hold WHERE process_code ${IN}`, p)).map((r) => [
      r.process_code as string,
      { state: r.state, note: r.note ?? null, by: r.updated_by ?? null, at: r.updated_at } as HoldView,
    ]),
  );
  const samplesBy = new Map<string, SampleView[]>();
  for (const r of sampleRows) {
    const vals = JSON.parse(r.vals ?? "{}");
    const state = JSON.parse(r.confirmed).includes(r.process_code) ? "confirmada" : r.status === "auto" ? "auto" : "pendente";
    const list = samplesBy.get(r.process_code) ?? [];
    list.push({
      item_id: r.item_id, name: r.name, tracking: sampleTracking(r.name, vals), approval: vals["Approval"] ?? null, received: vals["Date Received"] ?? null,
      url: r.url ?? null, state, confidence: r.confidence ?? null, evidence: r.evidence ?? null,
    });
    samplesBy.set(r.process_code, list);
  }
  const aiBy = new Map<string, AiInsight>(
    insights.map((r) => [r.process_code as string, { ...JSON.parse(r.result), created_at: r.created_at, model: r.model } as AiInsight]),
  );
  const itemIds = sitems.map((i) => i.id);
  const allItemIds = [...itemIds, ...oitems.map((i) => i.id)];
  const [checks, allocs, markRows] = await Promise.all([
    itemIds.length ? all(db, `SELECT shipment_item_id, done_at, done_by FROM item_checks WHERE shipment_item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(itemIds)]) : [],
    itemIds.length ? all(db, `SELECT shipment_item_id, done_qty, doing_qty, ops FROM gdi_alloc WHERE shipment_item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(itemIds)]) : [],
    allItemIds.length ? all(db, `SELECT item_id, kind, done_at, done_by FROM item_marks WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(allItemIds)]) : [],
  ]);
  const markMap = new Map(markRows.map((r) => [`${r.item_id}#${r.kind}`, { done_at: r.done_at as string, done_by: (r.done_by as string) ?? null }]));
  const productMap = await loadProducts(db, [...new Set([...sitems, ...oitems].map((i) => i.sku_code).filter(Boolean) as string[])]);
  const factoryKeys = [...new Set([...sitems, ...oitems].map((i) => itemKey(i.sku_code, i.sku)).filter(Boolean) as string[])];
  const factoryRows = factoryKeys.length
    ? await all(db, `SELECT item_key, parts, site_checked, checked_at FROM factory_items WHERE item_key IN (SELECT value FROM json_each(?))`, [JSON.stringify(factoryKeys)])
    : [];
  const factoryMap = new Map(factoryRows.map((r) => [r.item_key as string, r as unknown as FactoryRow]));
  // Desenvolvimento: lançamentos ligados pela coluna Process e a lista de SKUs (PO, planilha ou temporária).
  const devBy = await devInfosByCode(db, codes);
  const skuScopes = [...codes, ...[...devBy.values()].flat().map((d) => `dev:${d.item_id}`)];
  const skuRows = await all<SkuDbRow>(db, `SELECT id, scope, code, name, qty, source FROM sku_lists WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY id`, [JSON.stringify(skuScopes)]);
  // Foto e link do GoProduct na lista de itens: códigos da planilha e também os da lista de SKUs
  // (PO do FileMaker ou lista temporária), que viram os itens enquanto a planilha não tem nenhum.
  const gpCodes = [...new Set([...sitems, ...oitems].map((i) => (i.sku_code as string | null)?.toUpperCase()).filter(Boolean) as string[])];
  const gpLookup = [...new Set([...gpCodes, ...skuRows.map((r) => r.code?.trim().toUpperCase()).filter(Boolean) as string[]])];
  const gpRows = gpLookup.length ? await all(db, `SELECT pk, ipn, thumbnail FROM goproduct_parts WHERE ipn IN (SELECT value FROM json_each(?)) ORDER BY pk`, [JSON.stringify(gpLookup)]) : [];
  const gpMap = new Map<string, { pk: number; thumb: boolean }>();
  for (const r of gpRows) if (!gpMap.has(r.ipn)) gpMap.set(r.ipn as string, { pk: r.pk as number, thumb: !!r.thumbnail });
  const skuGp = await goproductByCode(db, [...skuRows.map((r) => r.code ?? ""), ...gpCodes]);
  const palette = await loadPalette(db);
  // Marcas dos itens que vêm da lista de SKUs ("sku:<id>"), antes dos itens da planilha.
  const skuIds = skuRows.map((r) => `sku:${r.id}`);
  if (skuIds.length) {
    for (const r of await all(db, `SELECT item_id, kind, done_at, done_by FROM item_marks WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(skuIds)])) {
      markMap.set(`${r.item_id}#${r.kind}`, { done_at: r.done_at as string, done_by: (r.done_by as string) ?? null });
    }
  }
  const primaryScopes = [...devBy.values()].map((list) => `dev:${list[0].item_id}`);
  const devManualRows = primaryScopes.length
    ? await all<{ scope: string; step_key: string; data: string }>(db, `SELECT scope, step_key, data FROM step_state WHERE scope IN (SELECT value FROM json_each(?))`, [JSON.stringify(primaryScopes)])
    : [];
  const checkMap = new Map(checks.map((c) => [c.shipment_item_id as string, { done_at: c.done_at, done_by: c.done_by }]));
  const gdiMap = new Map(allocs.map((a) => [a.shipment_item_id as string, { done: a.done_qty as number, doing: a.doing_qty as number, ops: JSON.parse(a.ops ?? "[]") as string[] }]));
  const today = todayBR();

  const views: OrderView[] = [];
  for (const order of orders) {
    const code = order.process_code as string;
    const itemsByPi = new Map<string, Record<string, any>[]>();
    for (const i of sitems) {
      if (i.process_code !== code) continue;
      const list = itemsByPi.get(i.pi_number) ?? [];
      list.push(i);
      itemsByPi.set(i.pi_number, list);
    }
    const state = new Map<string, Record<string, any>>();
    for (const s of states) {
      const scope = s.scope as string;
      if (scope === code) state.set(s.step_key, JSON.parse(s.data));
      else if (scope.startsWith(code + "-")) state.set(`${scope}#${s.step_key}`, JSON.parse(s.data));
    }
    const w = watchers.filter((x) => x.process_code === code).map((x) => x.user_email as string);
    const dev = devBy.get(code) ?? [];
    const mine = [code, ...dev.map((d) => `dev:${d.item_id}`)];
    const skus = buildSkuList(
      code,
      skuRows.filter((r) => mine.includes(r.scope)),
      oitems.filter((i) => i.process_code === code).map((i) => ({ code: i.sku_code ?? null, name: i.sku ?? null, qty: i.qty ?? null })),
      skuGp,
    );
    const v = compute({
      order,
      shipments: shipments.filter((s) => s.process_code === code),
      shipmentItems: itemsByPi,
      orderItems: oitems.filter((i) => i.process_code === code),
      checks: checkMap,
      gdi: gdiMap,
      marks: markMap,
      products: productMap,
      factory: factoryMap,
      goproduct: gpMap,
      state,
      watchers: w,
      ai: aiBy.get(code) ?? null,
      docsFolder: docsBy.get(code) ?? null,
      samples: samplesBy.get(code) ?? [],
      dev,
      skus,
      palette,
      devManual: devManualOf(dev[0] ? devManualRows.filter((r) => r.scope === `dev:${dev[0].item_id}`) : [], dev.length ? null : state),
      titles: new Map(titleRows.filter((t) => t.process_code === code).map((t) => [t.unit as string, t.title as string])),
      hold: holdBy.get(code) ?? null,
      fiscal: fiscalBy,
      today,
    });
    v.watching = !!viewer && w.includes(viewer);
    for (const u of v.units) u.watching = v.watching;
    views.push(v);
  }
  const pos = new Map(codes.map((c, i) => [c, i]));
  views.sort((a, b) => (pos.get(a.process_code) ?? 0) - (pos.get(b.process_code) ?? 0));
  return views;
}
