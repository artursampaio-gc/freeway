import { type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { DevProjectView, EventView, FiscalNoteView, ItemCell, ItemKind, ItemView, NextStep, OrderView, SampleView, Situacao, StepView, UnitView } from "../src/shared/types";
import { APPROVAL_LABEL, DESTINATION_LABEL, fmtDate, fmtQty, IMPORT_STATUS_LABEL, PRODUCTION_STATUS_LABEL, SITUACAO_LABEL } from "../src/shared/labels";
import { api, attempt, Empty, fillWidth, HealthChip, html, Legend, type Me, pct, STATUS_CHIP, StatusChip, todayIso, toast, Tracks, when } from "./core";
import { AiIcon, Icon, IconBtn } from "./icons";
import { DevBanner, DevCard, DevStepCard, SkuCard, TaskList } from "./dev";

// ---------- Pequenos componentes ----------

/** "Aguardando embarque" antes do frete; "Frete 2 de 3" quando o pedido foi dividido. */
function FreightChip({ u }: { u: UnitView }) {
  if (u.kind === "pedido") return html`<span class="chip" data-tip="O pedido ainda não embarcou">Aguardando embarque</span>`;
  if (u.freight_total > 1) {
    return html`<span class="chip accent" data-tip=${`O pedido ${u.process_code} foi dividido em ${u.freight_total} fretes. Cada frete é acompanhado como um pedido próprio.`}>Frete ${u.freight_index} de ${u.freight_total}</span>`;
  }
  return null;
}

function LaunchChip({ u }: { u: UnitView }) {
  if (u.launched_at) return html`<span class="chip ok" data-tip="Lançado no site: o processo está finalizado">Lançado ${fmtDate(u.launched_at, true)}</span>`;
  if (u.launch_due) return html`<span class="chip accent" data-tip="Data de lançamento prevista">Lançamento ${fmtDate(u.launch_due, true)}</span>`;
  return null;
}

/** Cancelado e on hold aparecem no lugar da saúde; lançado não tem saúde. */
function SituacaoChip({ u }: { u: UnitView }) {
  if (u.situacao === "cancelado") return html`<span class="chip late">Cancelado</span>`;
  if (u.situacao === "on_hold") return html`<span class="chip risk">On hold</span>`;
  return u.finalized ? null : html`<${HealthChip} health=${u.health} />`;
}

function unitStatusLine(u: UnitView): string {
  if (u.shipment) {
    const s = u.shipment;
    const extra = s.status === "transito" || s.status === "booking" ? (s.eta ? `ETA Santos ${fmtDate(s.eta, true)}` : "") : s.destination ? DESTINATION_LABEL[s.destination] ?? s.destination : "";
    return [s.status_label, extra].filter(Boolean).join(" · ");
  }
  return u.po_status ? IMPORT_STATUS_LABEL[u.po_status] ?? u.po_status : "";
}

function productsText(u: UnitView): string {
  if (u.title) return u.title;
  if (!u.products.length) return u.description ?? "";
  const shown = u.products.slice(0, 3).join(", ");
  return u.products.length > 3 ? `${shown} +${u.products.length - 3}` : shown;
}

function ActionButton({ n, onDone }: { n: NextStep; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await attempt(() => api("POST", `/api/unit/${n.unit}/action/${n.action}`), "Feito");
    setBusy(false);
    onDone();
  };
  return n.action === "notify_ilustracao"
    ? html`<${IconBtn} icon="send" variant="primary" tip="Avisar o time de ilustração" disabled=${busy} onClick=${run} />`
    : html`<${IconBtn} icon="check" variant="primary" tip="Marcar como feito hoje" disabled=${busy} onClick=${run} />`;
}

/** Próximos passos agrupados por processo, para a lista não ficar longa. */
function NextGroups({ steps, onDone, teamLabels }: { steps: NextStep[]; onDone: () => void; teamLabels: Record<string, string> }) {
  const groups = new Map<string, NextStep[]>();
  for (const n of steps) groups.set(n.unit_display, [...(groups.get(n.unit_display) ?? []), n]);
  return html`${[...groups].map(
    ([display, list]) => html`<div class="next" style=${{ alignItems: "flex-start" }}>
      <a class="mono" href=${`#/p/${display}`} style=${{ minWidth: "100px", paddingTop: "2px" }}><b>${display}</b></a>
      <div style=${{ flex: 1, minWidth: 0 }}>
        ${list.map(
          (n) => html`<div class="row" style=${{ padding: "2px 0", gap: "6px" }}>
            <span>${n.label}</span>
            ${n.ai && html`<${AiIcon} />`}
            ${n.team && html`<span class="chip">${teamLabels[n.team] ?? n.team}</span>`}
            ${n.action && html`<${ActionButton} n=${n} onDone=${onDone} />`}
          </div>`,
        )}
      </div>
      <${IconBtn} icon="arrowRight" tip=${`Abrir ${display}`} onClick=${() => (location.hash = `#/p/${display}`)} />
    </div>`,
  )}`;
}

function NextStepRow({ n, onDone, teamLabels, target }: { n: NextStep; onDone: () => void; teamLabels: Record<string, string>; target?: string }) {
  return html`<div class="next">
    <span class="ico">→</span>
    <div style=${{ flex: 1, minWidth: 0 }}>
      ${n.unit_display !== target && html`<a class="mono" href=${`#/p/${n.unit_display}`}>${n.unit_display}</a> · `}${n.label}
      ${n.ai && html` <${AiIcon} />`}
      ${n.team && html` <span class="chip">${teamLabels[n.team] ?? n.team}</span>`}
    </div>
    ${n.action
      ? html`<${ActionButton} n=${n} onDone=${onDone} />`
      : n.unit_display !== target
        ? html`<${IconBtn} icon="arrowRight" tip=${`Abrir ${n.unit_display}`} onClick=${() => (location.hash = `#/p/${n.unit_display}`)} />`
        : html`<${IconBtn} icon="arrowDown" tip="Ir até esta etapa na página" onClick=${() => document.getElementById(n.ai && n.step_key === "notas" ? "ai-card" : `step-${n.step_key}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} />`}
  </div>`;
}

// ---------- Seguindo (pedidos e desenvolvimentos que a pessoa segue) ----------

/** Minúsculas e sem acento, para a busca achar "Bolsa Voyage" digitando "bolsa voyage" ou "Ímã" digitando "ima". */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function UnitCard({ u, hits }: { u: UnitView; hits?: string[] }) {
  return html`<div class=${"card order" + (u.situacao === "cancelado" ? " stopped" : "")}>
    <div class="row">
      <a class="code" href=${`#/p/${u.display}`}>${u.display}</a>
      <${FreightChip} u=${u} />
      <span class="desc">${productsText(u)}</span>
      <span class="spacer"></span>
      <${LaunchChip} u=${u} />
      <${SituacaoChip} u=${u} />
      <span class="pct">${pct(u.total)}</span>
    </div>
    <div class="small muted" style=${{ marginTop: "2px" }}>${[u.supplier, unitStatusLine(u)].filter(Boolean).join(" · ")}</div>
    ${hits && hits.length > 0 &&
    html`<div class="small search-hits"><${Icon} name="search" /> ${hits.slice(0, 3).join(" ; ")}${hits.length > 3 ? ` +${hits.length - 3} itens` : ""}</div>`}
    <${Tracks} steps=${u.steps} />
    ${u.ai_note && html`<div class="ai-line"><${AiIcon} /> ${u.ai_note}</div>`}
    <div class="meta">
      <span><span class="faint">Agora: </span>${u.current}</span>
      ${u.next_milestone && html`<span><span class="faint">Próximo marco: </span>${u.next_milestone.label} · ${fmtDate(u.next_milestone.date, true)}</span>`}
    </div>
  </div>`;
}

type SortKey = "recentes" | "marco" | "progresso" | "codigo";
interface HomeFilters {
  sit: Situacao[];
  health: string;
  step: string;
  supplier: string;
  kind: string;
  show: "tudo" | "pedidos" | "devs";
  sort: SortKey;
}
const DEFAULT_FILTERS: HomeFilters = { sit: ["andamento"], health: "", step: "", supplier: "", kind: "", show: "tudo", sort: "recentes" };
const FILTERS_KEY = "freeway.seguindo.filtros";
const SITUACOES: [Situacao, string, string][] = [
  ["andamento", "Em andamento", "Pedidos andando normalmente"],
  ["on_hold", "On hold", "Parados: on hold no Freeway, ou o frete on hold na planilha"],
  ["cancelado", "Cancelados", "Cancelados no Freeway ou na planilha"],
  ["lancado", "Lançados", "Já lançados no site: processo finalizado"],
];

/** Os filtros ficam guardados neste navegador (se der); sem isso, voltam ao padrão. */
function loadFilters(): HomeFilters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (saved && Array.isArray(saved.sit) && saved.sit.length) return { ...DEFAULT_FILTERS, ...saved };
  } catch {
    // sem armazenamento: fica o padrão
  }
  return DEFAULT_FILTERS;
}

function sortUnits(list: UnitView[], sort: SortKey): UnitView[] {
  if (sort === "recentes") return list;
  const out = [...list];
  if (sort === "marco") out.sort((a, b) => (a.next_milestone?.date ?? "9999").localeCompare(b.next_milestone?.date ?? "9999"));
  else if (sort === "progresso") out.sort((a, b) => a.total - b.total);
  else out.sort((a, b) => a.display.localeCompare(b.display));
  return out;
}

export function Home({ me, onChange }: { me: Me; onChange: () => void }) {
  const [data, setData] = useState<{ units: UnitView[]; devs: DevProjectView[]; myNextSteps: NextStep[]; teamNextSteps: NextStep[] } | null>(null);
  const [f, setF] = useState<HomeFilters>(loadFilters);
  const [q, setQ] = useState("");
  const load = () => api("GET", "/api/home").then(setData).catch((e) => toast(e.message, true));
  useEffect(() => {
    load();
  }, []);
  if (!data) return html`<div class="loading">Carregando o que você segue…</div>`;
  const reload = () => {
    load();
    onChange();
  };
  const set = (p: Partial<HomeFilters>) => {
    const next = { ...f, ...p };
    setF(next);
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch {
      // sem armazenamento: o filtro vale só nesta visita
    }
  };
  const toggleSit = (s: Situacao) => {
    const sit = f.sit.includes(s) ? f.sit.filter((x) => x !== s) : [...f.sit, s];
    set({ sit: sit.length ? sit : DEFAULT_FILTERS.sit });
  };
  const clear = () => set({ ...DEFAULT_FILTERS, sort: f.sort });

  // Busca: cada palavra precisa estar no pedido (processo, fornecedor, frete…);
  // as que não estão precisam aparecer juntas num mesmo item, que é mostrado no cartão.
  const words = fold(q).split(/\s+/).filter(Boolean);
  const hitsOf = new Map<string, string[]>();
  const matches = (u: UnitView) => {
    const own = fold(u.search ?? u.display);
    const rest = words.filter((w) => !own.includes(w));
    if (!rest.length) return true;
    const hits = (u.search_items ?? []).filter((i) => rest.every((w) => fold(i).includes(w)));
    hitsOf.set(u.unit, hits);
    return hits.length > 0;
  };
  const found = words.length ? data.units.filter(matches) : data.units;
  // Saúde só vale para o que está andando; os outros filtros, para tudo.
  const pool = found.filter(
    (u) => (!f.health || (u.situacao === "andamento" && u.health === f.health)) && (!f.step || u.current_step === f.step) && (!f.supplier || u.supplier === f.supplier) && (!f.kind || u.order_kind === f.kind),
  );
  const countSit = (s: Situacao) => pool.filter((u) => u.situacao === s).length;
  const showUnits = f.show !== "devs";
  const visible = showUnits ? sortUnits(pool.filter((u) => f.sit.includes(u.situacao)), f.sort) : [];

  // Opções dos filtros, com quantos pedidos (nas situações escolhidas) há em cada uma.
  const inSit = data.units.filter((u) => f.sit.includes(u.situacao));
  const stepOpts = new Map<string, { label: string; pos: number; n: number }>();
  for (const u of data.units) {
    if (!u.current_step) continue;
    const pos = u.steps.findIndex((s) => s.key === u.current_step);
    const o = stepOpts.get(u.current_step) ?? { label: u.steps[pos]?.label ?? u.current_step, pos, n: 0 };
    if (inSit.includes(u)) o.n++;
    stepOpts.set(u.current_step, o);
  }
  const steps = [...stepOpts].filter(([k, o]) => o.n > 0 || k === f.step).sort((a, b) => a[1].pos - b[1].pos);
  const suppliers = [...new Set(data.units.map((u) => u.supplier).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "pt"));
  const kinds = [...new Set(data.units.map((u) => u.order_kind).filter(Boolean))].sort();

  // Desenvolvimentos ainda não têm fornecedor, etapa de pedido nem empresa: com esses filtros, ficam de fora.
  const devs = data.devs ?? [];
  const devsShown = f.show !== "pedidos" && f.sit.includes("andamento") && !f.step && !f.supplier && !f.kind;
  const devsVisible = devsShown
    ? devs.filter((p) => {
        if (f.health && p.health !== f.health) return false;
        const text = fold([p.info.name, p.info.launch_group, p.info.tipo, p.info.people.join(" "), p.info.process_codes.join(" ")].filter(Boolean).join(" "));
        return words.every((w) => text.includes(w));
      })
    : [];

  const filtered = f.sit.join() !== DEFAULT_FILTERS.sit.join() || !!f.health || !!f.step || !!f.supplier || !!f.kind || f.show !== "tudo";
  const narrowed = filtered || words.length > 0;
  const clearLink = filtered && html` <button class="link" type="button" onClick=${clear}>Limpar filtros</button>`;

  return html`<div>
    <div class="row"><h1>Seguindo</h1><span class="spacer"></span><${Legend} /></div>
    ${data.myNextSteps.length > 0 &&
    html`<div class="section card">
      <h2>Meus próximos passos</h2>
      <${NextGroups} steps=${data.myNextSteps} onDone=${reload} teamLabels=${me.teamLabels} />
    </div>`}
    ${data.teamNextSteps.length > 0 &&
    html`<div class="section card">
      <h2>Pendências dos meus times</h2>
      <${NextGroups} steps=${data.teamNextSteps} onDone=${reload} teamLabels=${me.teamLabels} />
    </div>`}
    <div class="section">
      ${data.units.length === 0 && devs.length === 0
        ? html`<${Empty} title="Você ainda não segue nenhum pedido ou desenvolvimento">
            <p>Procure um processo pelo código, SKU ou fornecedor, ou abra um lançamento em Desenvolvimentos, e clique em seguir. Só o que você segue aparece aqui.</p>
            <div class="row" style=${{ justifyContent: "center", gap: "8px" }}><a href="#/buscar"><button class="primary">Ver pedidos</button></a><a href="#/dev"><button>Ver desenvolvimentos</button></a></div>
          </${Empty}>`
        : html`<div class="row small muted" style=${{ marginBottom: "8px" }}>
              <div class="search-box search-home">
                <${Icon} name="search" />
                <input placeholder="Buscar processo, item, SKU, fornecedor, BL…" value=${q}
                  onInput=${(e: any) => setQ(e.target.value)} onKeyDown=${(e: KeyboardEvent) => e.key === "Escape" && setQ("")} />
                ${q && html`<button class="clear" title="Limpar busca" onClick=${() => setQ("")}>×</button>`}
              </div>
              <span>${narrowed ? `${visible.length} de ${data.units.length} pedidos` : `${visible.length} pedido${visible.length === 1 ? "" : "s"}`}</span>
            </div>
            <div class="filters">
              <div class="fchips" role="group" aria-label="Situação">
                ${SITUACOES.map(
                  ([s, label, tip]) => html`<button type="button" class=${"fchip" + (f.sit.includes(s) ? " on" : "")} aria-pressed=${f.sit.includes(s)} data-tip=${tip} onClick=${() => toggleSit(s)}>
                    ${label}<span class="n">${countSit(s)}</span>
                  </button>`,
                )}
              </div>
              <select value=${f.step} aria-label="Etapa atual" onChange=${(e: any) => set({ step: e.target.value })}>
                <option value="">Todas as etapas</option>
                ${steps.map(([k, o]) => html`<option value=${k}>${o.label} (${o.n})</option>`)}
              </select>
              <select value=${f.health} aria-label="Prazo" onChange=${(e: any) => set({ health: e.target.value })}>
                <option value="">Qualquer prazo</option>
                <option value="late">Atrasados</option>
                <option value="risk">Em risco</option>
                <option value="ok">No prazo</option>
              </select>
              ${suppliers.length > 1 &&
              html`<select value=${f.supplier} aria-label="Fornecedor" onChange=${(e: any) => set({ supplier: e.target.value })}>
                <option value="">Todos os fornecedores</option>
                ${suppliers.map((s) => html`<option value=${s}>${s}</option>`)}
              </select>`}
              ${kinds.length > 1 &&
              html`<select value=${f.kind} aria-label="Empresa" onChange=${(e: any) => set({ kind: e.target.value })}>
                <option value="">${kinds.join(" e ")}</option>
                ${kinds.map((k) => html`<option value=${k}>Só ${k}</option>`)}
              </select>`}
              ${devs.length > 0 &&
              html`<select value=${f.show} aria-label="Mostrar" onChange=${(e: any) => set({ show: e.target.value })}>
                <option value="tudo">Pedidos e desenvolvimentos</option>
                <option value="pedidos">Só pedidos</option>
                <option value="devs">Só desenvolvimentos</option>
              </select>`}
              <select value=${f.sort} aria-label="Ordenar" onChange=${(e: any) => set({ sort: e.target.value })}>
                <option value="recentes">Ordem: seguidos por último</option>
                <option value="marco">Ordem: próximo marco</option>
                <option value="progresso">Ordem: menos avançados</option>
                <option value="codigo">Ordem: código</option>
              </select>
              ${clearLink}
            </div>
            ${showUnits &&
            html`${devs.length > 0 && html`<div class="section-title"><h2>Pedidos</h2><span class="small faint">${narrowed ? `${visible.length} de ${data.units.length}` : visible.length}</span></div>`}
              ${data.units.length === 0
                ? html`<p class="small faint">Nenhum pedido seguido. <a href="#/buscar">Ver pedidos</a></p>`
                : visible.length === 0 &&
                  html`<div class="card muted">
                    ${words.length ? html`Nenhum pedido seu tem “${q.trim()}”${filtered ? " nesses filtros" : ""}.` : "Nenhum pedido nesses filtros."}${clearLink}
                    ${words.length > 0 && html` Para procurar em todos os processos, use <a href="#/buscar">Pedidos</a>.`}
                  </div>`}
              ${visible.map((u) => html`<${UnitCard} u=${u} hits=${words.length ? hitsOf.get(u.unit) : undefined} />`)}`}
            ${devs.length > 0 &&
            f.show !== "pedidos" &&
            html`<div class="section-title" style=${{ marginTop: showUnits ? "18px" : "0" }}><h2>Desenvolvimentos</h2><span class="small faint">${devsVisible.length < devs.length ? `${devsVisible.length} de ${devs.length}` : devs.length}</span></div>
              ${devsVisible.map((p) => html`<${DevCard} p=${p} />`)}
              ${devsVisible.length === 0 &&
              html`<p class="small faint">
                ${!devsShown ? "Os desenvolvimentos ficam de fora com esses filtros (só aparecem em andamento, sem filtro de etapa, fornecedor ou empresa)." : words.length ? `Nenhum desenvolvimento seguido com “${q.trim()}”.` : "Nenhum desenvolvimento nesses filtros."}${clearLink}
              </p>`}`}`}
    </div>
  </div>`;
}

// ---------- Cartões de etapa ----------

interface Field {
  k: string;
  label: string;
  type: "text" | "date" | "url" | "select";
  ph?: string;
  options?: [string, string][];
}

const FIELDS: Record<string, Field[]> = {
  amostra: [
    { k: "tracking", label: "Rastreio FedEx", type: "text", ph: "887065866739" },
    { k: "destination", label: "Destino", type: "text", ph: "Fortaleza" },
    { k: "delivered_at", label: "Entregue em (se não vier pela FedEx)", type: "date" },
  ],
  amostra_validacao: [
    { k: "approval", label: "Aprovação", type: "select", options: [["", "Ainda não avaliada"], ["aprovado", "Aprovada"], ["aprovado_restricao", "Aprovada com restrição"], ["reprovado", "Reprovada"]] },
    { k: "approval_note", label: "Observação da aprovação", type: "text" },
  ],
  documentacao: [
    { k: "docs_done_at", label: "Documentação enviada em", type: "date" },
    { k: "docs_link", label: "Link da documentação no Drive (PO, carton marks, barcodes)", type: "url" },
  ],
  producao: [
    { k: "start", label: "Início da produção", type: "date" },
    { k: "due", label: "Prazo previsto de conclusão", type: "date" },
    { k: "note", label: "Observação", type: "text" },
  ],
  alinhamento: [
    { k: "carrier", label: "Transportadora", type: "select", options: [["fedex", "FedEx"], ["correios", "Correios"], ["outro", "Outra"]] },
    { k: "tracking", label: "Rastreio das 20 amostras", type: "text" },
    { k: "delivered_at", label: "Chegaram em Extrema em", type: "date" },
    { k: "note", label: "Observação", type: "text" },
  ],
  fci: [
    { k: "number", label: "Número da FCI", type: "text" },
    { k: "link", label: "Link do PDF (se estiver no Drive)", type: "url" },
    { k: "note", label: "Observação", type: "text" },
  ],
  filmagem: [
    { k: "delivered_at", label: "Amostras entregues à filmagem em", type: "date" },
    { k: "due", label: "Prazo informado pela filmagem", type: "date" },
    { k: "link", label: "Link dos vídeos", type: "url" },
    { k: "done_at", label: "Filmagem concluída em", type: "date" },
    { k: "note", label: "Observação", type: "text" },
  ],
  estampas: [
    { k: "decision", label: "Avaliação da ilustração", type: "select", options: [["", "Aguardando avaliação"], ["nao_precisa", "Não precisa"], ["precisa", "Precisa criar/adaptar"]] },
    { k: "due", label: "Prazo", type: "date" },
    { k: "link", label: "Link das estampas", type: "url" },
    { k: "note", label: "Observação", type: "text" },
  ],
  marketing: [
    { k: "due", label: "Prazo", type: "date" },
    { k: "link", label: "Link do material", type: "url" },
    { k: "note", label: "Observação", type: "text" },
  ],
  lancamento: [
    { k: "due", label: "Data de lançamento prevista", type: "date" },
    { k: "done_at", label: "Lançado no site em", type: "date" },
    { k: "note", label: "Observação", type: "text" },
  ],
  _manual: [
    { k: "due", label: "Prazo", type: "date" },
    { k: "link", label: "Link", type: "url" },
    { k: "note", label: "Observação", type: "text" },
  ],
};

const CAN_FINISH = new Set(["producao", "alinhamento", "fci", "filmagem", "estampas", "marketing", "mockups", "cadastro_site", "cadastro_wms"]);
const CAN_NA = new Set(["amostra", "fci", "filmagem", "estampas", "marketing", "mockups", "cadastro_site", "cadastro_wms"]);
const STEP_MANUAL = new Set(["mockups", "cadastro_site", "cadastro_wms"]);

/** Pontos dentro de uma etapa (ex.: documentação na Produção). Com `patch`, dá para marcar e desmarcar. */
function Points({ s, patch }: { s: StepView; patch?: (p: Record<string, unknown>, ok: string) => void }) {
  if (!s.points?.length) return null;
  return html`<div class="points">${s.points.map(
    (p) => html`<div class="point">
      <span class=${"point-mark" + (p.done ? " done" : "")}><${Icon} name=${p.done ? "checkCircle" : "circle"} /></span>
      <div style=${{ flex: 1, minWidth: 0 }}>
        <div class="small">${p.label}<span class="faint">${p.done_at ? ` · pronta em ${fmtDate(p.done_at, true)}${p.done_by?.startsWith("Drive") ? " (lida do Drive)" : ""}` : p.inferred ? " · pedido já embarcou" : " · pendente"}</span></div>
        ${p.hint && html`<div class="small faint">${p.hint}</div>`}
        ${p.link
          ? html`<a class="small" href=${p.link} target="_blank" rel="noopener">${p.link_label ?? "Arquivos no Drive"} ↗</a>`
          : html`<div class="small faint">Pasta do pedido no Drive ainda não encontrada</div>`}
      </div>
      ${patch && !p.done && html`<${IconBtn} icon="checkCircle" tip=${`Marcar ${p.label.toLowerCase()} como pronta hoje`} onClick=${() => patch({ [p.field]: todayIso() }, "Documentação pronta")} />`}
      ${patch && p.done_at && html`<${IconBtn} icon="reopen" variant="ghost" tip=${`Desmarcar ${p.label.toLowerCase()}`} onClick=${() => patch({ [p.field]: null }, "Desmarcado")} />`}
    </div>`,
  )}</div>`;
}

const SAMPLE_STATE: Record<SampleView["state"], string> = { confirmada: "confirmada", auto: "ligada pela IA", pendente: "sugestão da IA" };

/** Amostras do Warehouse Samples (Monday) ligadas ao pedido, com confirmação das sugestões. */
function Samples({ samples, code, reload }: { samples: SampleView[]; code: string; reload: () => void }) {
  if (!samples.length) return null;
  const decide = async (s: SampleView, ok: boolean) => {
    if (await attempt(() => api("POST", "/api/sample-link", { item_id: s.item_id, process_code: code, ok }), ok ? "Amostra confirmada" : "Ligação descartada")) reload();
  };
  return html`<div class="points">
    <div class="small faint">Amostras no Monday (Warehouse Samples)</div>
    ${samples.map(
      (s) => html`<div class="point">
        <div style=${{ flex: 1, minWidth: 0 }}>
          <div class="small">${s.tracking && html`<span class="mono">${s.tracking}</span> · `}${s.tracking ? s.name.replace(s.tracking, "").replace(/^\s+/, "") || s.name : s.name}</div>
          <div class="small faint" data-tip=${s.evidence ?? undefined}>${[s.approval && `Approval: ${s.approval}`, s.received && `recebida ${fmtDate(s.received, true)}`, `${SAMPLE_STATE[s.state]}${s.state !== "confirmada" && s.confidence != null ? ` (${Math.round(s.confidence * 100)}%)` : ""}`].filter(Boolean).join(" · ")}</div>
          ${s.url && html`<a class="small" href=${s.url} target="_blank" rel="noopener">Abrir no Monday ↗</a>`}
        </div>
        ${s.state !== "confirmada" && html`<${IconBtn} icon="check" tip="É amostra deste pedido" onClick=${() => decide(s, true)} />`}
        <${IconBtn} icon="x" variant="ghost" tip="Não é amostra deste pedido" onClick=${() => decide(s, false)} />
      </div>`,
    )}
  </div>`;
}

/** Cartão editável de uma etapa. `unit` é onde grava: o pedido (vale para todos) ou um embarque. */
const EDIT_TARGET: Record<string, string> = { amostra_validacao: "amostra", documentacao: "producao" };

function StepCard({ unit, orderCode, freights, s, reload, children }: { unit: string; orderCode: string; freights: number; s: StepView; reload: () => void; children?: ComponentChildren }) {
  const [editing, setEditing] = useState(false);
  const d = s.data ?? {};
  const fields = FIELDS[s.key] ?? FIELDS._manual;
  const [form, setForm] = useState<Record<string, any>>({});
  useEffect(() => {
    if (editing) setForm(Object.fromEntries(fields.map((f) => [f.k, d[f.k] ?? (f.k === "carrier" ? "fedex" : "")])));
  }, [editing]);
  // Validação da amostra e documentação gravam onde sempre gravaram (amostra e produção).
  const target = EDIT_TARGET[s.key] ?? s.key;
  const patch = async (p: Record<string, unknown>, ok = "Salvo") => {
    if (await attempt(() => api("PATCH", `/api/unit/${unit}/step/${target}`, p), ok)) {
      setEditing(false);
      reload();
    }
  };
  const save = (e: Event) => {
    e.preventDefault();
    const changed: Record<string, unknown> = {};
    // Num valor herdado do pedido, salvar grava tudo no embarque (ele passa a ter o próprio valor).
    for (const f of fields) if (s.inherited || (form[f.k] ?? "") !== (d[f.k] ?? "")) changed[f.k] = form[f.k];
    if (!Object.keys(changed).length) return setEditing(false);
    patch(changed);
  };
  const action = async (a: string, ok: string) => {
    if (await attempt(() => api("POST", `/api/unit/${unit}/action/${a}`), ok)) reload();
  };
  const upload = async (e: any) => {
    const file: File | undefined = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1_500_000) return toast("O PDF precisa ter até 1,5 MB", true);
    const b64 = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] ?? "");
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    if (await attempt(() => api("POST", `/api/process/${orderCode}/documents`, { unit, kind: "fci", filename: file.name, mime: file.type, content_b64: b64 }), "FCI anexada")) reload();
  };

  const links: [string, string][] = [];
  if (d.link) links.push([s.key === "filmagem" ? "Vídeos" : s.key === "fci" ? "PDF da FCI" : "Link", d.link]);
  const approved = s.key === "amostra_validacao" && d.approval && d.approval !== "reprovado";
  // Amostra, produção e alinhamento são do pedido original: num pedido dividido, valem para todos os fretes.
  const shared = s.scope === "order" && freights > 1;

  return html`<div id=${`step-${s.key}`} class=${`step-card st-border-${s.status}`}>
    <div class="head"><h3>${s.label}</h3><span class="spacer"></span><${StatusChip} status=${s.status} /></div>
    <div class="detail">${s.detail}</div>
    ${s.status !== "na" && html`<div class="mini"><div class=${"fill st-" + s.status} style=${{ width: fillWidth(s), height: "100%" }}></div></div>`}
    ${s.inherited && html`<div class="small faint" style=${{ marginTop: "6px" }}>Marcado antes do pedido ser dividido em fretes. Editar aqui vale só para este frete.</div>`}
    ${shared && html`<div class="small faint" style=${{ marginTop: "6px" }}>Do pedido ${orderCode}: vale para os ${freights} fretes.</div>`}
    ${s.key === "amostra_validacao" && d.approval && html`<div class="small muted" style=${{ marginTop: "6px" }}>${APPROVAL_LABEL[d.approval]}${d.approval_by ? ` por ${d.approval_by}` : ""}${d.approval_note ? ` · ${d.approval_note}` : ""}</div>`}
    ${(s.key === "amostra" || s.key === "alinhamento") && d.tracking && html`<div class="small muted" style=${{ marginTop: "6px" }}>Rastreio ${d.tracking}${d.fedex?.checked_at ? ` · consultado em ${fmtDate(d.fedex.checked_at.slice(0, 10), true)}` : ""}${d.fedex?.error ? ` · erro FedEx: ${d.fedex.error}` : ""}</div>`}
    ${d.number && html`<div class="small muted" style=${{ marginTop: "6px" }}>FCI nº ${d.number}</div>`}
    ${d.note && html`<div class="small muted" style=${{ marginTop: "6px" }}>${d.note}</div>`}
    ${links.map(([l, href]) => html`<div class="small" style=${{ marginTop: "6px" }}><a href=${href} target="_blank" rel="noopener">${l} ↗</a></div>`)}
    ${s.key === "documentacao" && (d.folder
      ? html`<div class="small" style=${{ marginTop: "6px" }}><a href=${d.folder} target="_blank" rel="noopener">${d.folder_name ? `Pasta ${d.folder_name} no Drive` : "Documentação no Drive"} ↗</a></div>`
      : html`<div class="small faint" style=${{ marginTop: "6px" }}>Pasta do pedido no Drive (FileMaker) ainda não encontrada</div>`)}
    <${Points} s=${s} patch=${editing ? undefined : patch} />
    ${children}
    ${editing
      ? html`<form onSubmit=${save}>
          ${fields.map(
            (f) => html`<label>${f.label}
              ${f.type === "select"
                ? html`<select value=${form[f.k] ?? ""} onChange=${(e: any) => setForm({ ...form, [f.k]: e.target.value })}>
                    ${f.options!.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
                  </select>`
                : html`<input type=${f.type} placeholder=${f.ph ?? ""} value=${form[f.k] ?? ""} onInput=${(e: any) => setForm({ ...form, [f.k]: e.target.value })} />`}
            </label>`,
          )}
          <div class="row"><${IconBtn} icon="check" variant="primary" type="submit" tip="Salvar" /><${IconBtn} icon="x" variant="ghost" tip="Cancelar" onClick=${() => setEditing(false)} /></div>
        </form>`
      : html`<div class="actions">
          ${s.status !== "na" && !(s.key === "alinhamento" && !d.enabled) && html`<${IconBtn} icon="pencil" tip=${`Editar ${s.label.toLowerCase()}`} onClick=${() => setEditing(true)} />`}
          ${s.key === "alinhamento" && html`<button class="small" onClick=${() => patch({ enabled: !d.enabled }, d.enabled ? "Alinhamento desligado" : "Alinhamento ligado")}>${d.enabled ? "Desligar" : "Ligar para este pedido"}</button>`}
          ${s.key === "estampas" && s.status === "doing" && !d.notified_at && html`<button class="small primary with-icon" onClick=${() => action("notify_ilustracao", "Time de ilustração avisado")}><${Icon} name="send" />Avisar o time de ilustração</button>`}
          ${s.key === "filmagem" && s.status === "doing" && !d.delivered_at && html`<button class="small primary" onClick=${() => action("filmagem_entregue", "Registrado")}>Amostras entregues hoje</button>`}
          ${s.key === "amostra_validacao" && !approved && s.status !== "na" && (d.tracking || d.delivered_at) && html`<button class="small primary" onClick=${() => patch({ approval: "aprovado" }, "Amostra aprovada")}>Aprovar amostra</button>`}
          ${s.key === "documentacao" && !d.docs_done_at && s.source !== "inferido" && html`<${IconBtn} icon="checkCircle" tip="Marcar a documentação como enviada hoje" onClick=${() => patch({ docs_done_at: todayIso() }, "Documentação enviada")} />`}
          ${s.key === "documentacao" && d.docs_done_at && html`<${IconBtn} icon="reopen" variant="ghost" tip="Desmarcar a documentação" onClick=${() => patch({ docs_done_at: null }, "Desmarcado")} />`}
          ${s.key === "fci" && s.status !== "done" && s.status !== "na" && html`<span style=${{ display: "inline-flex" }}><${IconBtn} icon="paperclip" tip="Anexar o PDF da FCI (até 1,5 MB)" onClick=${(e: any) => e.currentTarget.nextElementSibling.click()} /><input type="file" accept="application/pdf" style=${{ display: "none" }} onChange=${upload} /></span>`}
          ${STEP_MANUAL.has(s.key) && s.status === "todo" && !d.started_at && !s.detail.startsWith("Aguardando") && html`<${IconBtn} icon="play" tip="Iniciar hoje" onClick=${() => patch({ started_at: todayIso() }, "Iniciado")} />`}
          ${CAN_FINISH.has(s.key) && s.status !== "done" && s.status !== "na" && !(s.key === "alinhamento" && !d.enabled) && html`<${IconBtn} icon="checkCircle" tip="Concluir hoje" onClick=${() => patch({ done_at: todayIso() }, "Concluído")} />`}
          ${s.key === "lancamento" && s.status !== "done" && html`<${IconBtn} icon="checkCircle" variant="primary" tip="Marcar como lançado no site hoje (finaliza o processo)" onClick=${() => patch({ done_at: todayIso() }, "Lançado: processo finalizado")} />`}
          ${d.done_at && !s.inherited && html`<${IconBtn} icon="reopen" variant="ghost" tip=${s.key === "lancamento" ? "Desfazer o lançamento" : "Reabrir a etapa"} onClick=${() => patch({ done_at: null }, "Reaberto")} />`}
          ${CAN_NA.has(s.key) && html`<${IconBtn} icon="ban" variant=${d.na ? "on" : "ghost"} tip=${d.na ? "Não se aplica. Clique para a etapa voltar a valer" : "Marcar como não se aplica"} onClick=${() => patch({ na: !d.na }, d.na ? "Etapa reativada" : "Marcada como não se aplica")} />`}
        </div>`}
  </div>`;
}

/** Cartão só de leitura (dados que vêm da planilha). */
function InfoCard({ s, children }: { s: StepView; children?: ComponentChildren }) {
  return html`<div id=${`step-${s.key}`} class=${`step-card st-border-${s.status}`}>
    <div class="head"><h3>${s.label}</h3><span class="spacer"></span><${StatusChip} status=${s.status} /></div>
    <div class="detail">${s.detail}${s.source === "planilha" && html` <span class="faint">· planilha</span>`}</div>
    ${s.status !== "na" && html`<div class="mini"><div class=${"fill st-" + s.status} style=${{ width: fillWidth(s), height: "100%" }}></div></div>`}
    <${Points} s=${s} />
    ${children}
  </div>`;
}

const FISCAL_MARK_ICON = { done: "checkCircle", blocked: "ban", risk: "clock", doing: "clock", todo: "circle" } as const;
const FISCAL_VIA: Record<string, string> = { ref: "pela Ref Trading / BL", pi: "pela PI escrita no processo", historico: "pelos códigos do Histórico do fiscal", nf: "pela NF" };

/** Nota de importação do frete, como está na planilha do time fiscal: situação, as 6 etapas e o que falta. */
function FiscalCard({ notes, status }: { notes: FiscalNoteView[]; status: string }) {
  if (!notes.length) {
    if (status !== "desembaraco") return null;
    return html`<div id="step-nota" class="step-card">
      <div class="head"><h3>Nota de importação</h3><span class="spacer"></span><${StatusChip} status="todo" /></div>
      <div class="detail">Ainda não aparece na planilha de notas do fiscal. Ela entra quando o despachante manda o extrato da DUIMP.</div>
    </div>`;
  }
  return html`${notes.map(
    (n) => html`<div id="step-nota" class=${`step-card st-border-${n.state}`}>
      <div class="head"><h3>Nota de importação</h3><span class="spacer"></span><span class=${"chip " + (STATUS_CHIP[n.state]?.[0] ?? "")}>${n.status ?? STATUS_CHIP[n.state]?.[1]}</span></div>
      <div class="detail">${[n.processo, n.duimp && `DUIMP ${n.duimp}`, n.nf && `NF ${n.nf}`, n.valor].filter(Boolean).join(" · ")} <span class="faint">· planilha do fiscal</span></div>
      ${n.falta && n.state !== "done" && html`<div class="small fiscal-falta"><b>O que falta:</b> ${n.falta}</div>`}
      <div class="points">
        ${n.etapas.map(
          (e, i) => html`<div class="point">
            <span class=${"point-mark " + e.mark}><${Icon} name=${FISCAL_MARK_ICON[e.mark]} /></span>
            <div class="small">${i + 1} · ${e.label}${e.value && html`<span class="faint"> · ${e.value}</span>`}</div>
          </div>`,
        )}
      </div>
      <div class="small faint" style=${{ marginTop: "8px" }}>${[n.mudou && `Última mudança no fiscal: ${n.mudou}`, n.via && `ligada ao frete ${FISCAL_VIA[n.via] ?? n.via}`].filter(Boolean).join(" · ")}</div>
    </div>`,
  )}`;
}

/** Pizza radial do quanto já foi feito (frente em andamento). */
function Pie({ pct }: { pct: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return html`<svg class="pie" viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r=${r} class="pie-bg" />
    <circle cx="10" cy="10" r=${r} class="pie-fg" stroke-dasharray=${`${(Math.max(0.04, pct) * c).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 10 10)" />
  </svg>`;
}

const CELL_COLS: { kind: ItemKind; label: string }[] = [
  { kind: "fci", label: "FCI" },
  { kind: "industrializacao", label: "Industrialização" },
  { kind: "cadastro", label: "Cadastro" },
  { kind: "wms", label: "WMS" },
  { kind: "lancado", label: "Lançado no site" },
];

/** Célula da lista de produtos: check verde (concluído), pizza com o % (em andamento) ou relógio vermelho (aguardando). */
function StatusCell({ cell, onClick, actionTip }: { cell?: ItemCell; onClick?: () => void; actionTip?: string }) {
  if (!cell || cell.state === "na") return html`<span class="faint" data-tip=${cell?.detail}>—</span>`;
  const icon =
    cell.state === "done"
      ? html`<span class="cell-ico done"><${Icon} name="checkCircle" /></span>`
      : cell.state === "doing"
        ? html`<span class="cell-ico doing"><${Pie} pct=${cell.pct ?? 0} /></span>`
        : html`<span class="cell-ico todo"><${Icon} name="clock" /></span>`;
  const tip = [cell.detail, cell.state === "doing" && cell.pct != null ? `${Math.round(cell.pct * 100)}%` : "", actionTip].filter(Boolean).join(" · ");
  return onClick
    ? html`<button class="cell-btn" aria-label=${tip} data-tip=${tip} onClick=${onClick}>${icon}</button>`
    : html`<span data-tip=${tip}>${icon}</span>`;
}

function ItemsTable({ items, canInd, onCheck, onMark }: {
  items: ItemView[];
  canInd?: boolean;
  onCheck?: (id: string, done: boolean) => void;
  onMark?: (id: string, kind: ItemKind, done: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase();
  const shown = words ? items.filter((i) => `${i.code ?? ""} ${i.name ?? ""} ${i.item_supplier ?? ""}`.toLowerCase().includes(words)) : items;
  const cols = CELL_COLS.filter((c) => items.some((i) => i.status?.[c.kind] && i.status[c.kind].state !== "na"));
  const hasStock = items.some((i) => i.product);
  const action = (i: ItemView, kind: ItemKind): { click?: () => void; tip?: string } => {
    const cell = i.status?.[kind];
    if (!cell) return {};
    if (kind === "industrializacao") {
      if (!canInd || !onCheck) return {};
      return i.done_at ? { click: () => onCheck(i.id, false), tip: "clique para desmarcar" } : { click: () => onCheck(i.id, true), tip: "clique para marcar como industrializado" };
    }
    if (!onMark) return {};
    if (cell.marked) return { click: () => onMark(i.id, kind, false), tip: "clique para desmarcar" };
    if (cell.state !== "done") return { click: () => onMark(i.id, kind, true), tip: "clique para marcar como feito" };
    return {};
  };
  return html`<div>
    ${items.length > 8 &&
    html`<div class="row" style=${{ marginTop: "8px" }}>
      <div class="search-box"><${Icon} name="search" /><input placeholder="Buscar SKU ou produto" value=${q} onInput=${(e: any) => setQ(e.target.value)} /></div>
      <span class="small faint">${words ? `${shown.length} de ${items.length} itens` : `${items.length} itens`}</span>
    </div>`}
    <div class="items-wrap"><table class="items">
      <thead><tr>
        <th>SKU</th><th>Produto</th><th class="num">Quantidade</th>
        ${items.some((i) => i.boxes != null) && html`<th class="num">Caixas</th>`}
        ${items.some((i) => i.pending_qty != null) && html`<th class="num">Pendente</th>`}
        ${hasStock && html`<th data-tip="Saldo no WMS (planilha de produtos e estoque), somando as variações do código">Estoque WMS</th>`}
        ${cols.map((c) => html`<th class="cell">${c.label}</th>`)}
      </tr></thead>
      <tbody>
        ${shown.map(
          (i) => html`<tr>
            <td class="mono">${i.code ?? html`<span class="faint" data-tip="Sem código na planilha nem no GoProduct">—</span>`}</td>
            <td><div class="prod-cell">
              ${i.goproduct_img
                ? html`<img class="prod-thumb" src=${i.goproduct_img} alt="" loading="lazy" onError=${(e: any) => (e.currentTarget.style.visibility = "hidden")} />`
                : html`<span class="prod-thumb empty"></span>`}
              <div>
              ${isLaunch(i) && html`<${StarIcon} />`}${i.name ?? i.item_supplier}
              ${i.goproduct &&
              html` <a class="ext-link" href=${`https://goproduct.gogroupbr.com/web/part/${i.goproduct}/details`} target="_blank" rel="noopener" data-tip="Abrir o produto no GoProduct"><${Icon} name="external" /></a>`}
              ${i.product?.status && /descontinu|inativ|sem previs/i.test(i.product.status) && html` <span class="chip late" data-tip="Status na planilha de produtos">${i.product.status}</span>`}
              <div class="small faint">${i.name ? i.item_supplier : ""}${i.product?.origem && !/importa/i.test(i.product.origem) && html` · <span data-tip="Origem na planilha de produtos">${i.product.origem}</span>`}</div>
              </div>
            </div></td>
            <td class="num">${fmtQty(i.qty)}</td>
            ${items.some((x) => x.boxes != null) && html`<td class="num">${fmtQty(i.boxes)}</td>`}
            ${items.some((x) => x.pending_qty != null) && html`<td class="num">${fmtQty(i.pending_qty)}</td>`}
            ${hasStock && html`<td class="small" data-tip=${i.stock?.detail.join("\n") || undefined}>
              ${i.stock
                ? [i.stock.itapeva && `Itapeva ${fmtQty(i.stock.itapeva)}`, i.stock.extrema && `Extrema ${fmtQty(i.stock.extrema)}`, i.stock.linhares && `Linhares ${fmtQty(i.stock.linhares)}`, i.stock.outros && `outros ${fmtQty(i.stock.outros)}`].filter(Boolean).join(" · ") || "0"
                : html`<span class="faint">${i.product ? "0" : "—"}</span>`}
            </td>`}
            ${cols.map((c) => {
              const a = action(i, c.kind);
              return html`<td class="cell"><${StatusCell} cell=${i.status?.[c.kind]} onClick=${a.click} actionTip=${a.tip} /></td>`;
            })}
          </tr>`,
        )}
        ${shown.length === 0 && html`<tr><td colspan="10" class="small faint">Nenhum item com "${q}".</td></tr>`}
      </tbody>
    </table></div>
  </div>`;
}

interface MondayUpdate {
  id: string;
  board: string;
  item: string;
  sub: string | null;
  url: string | null;
  column: string;
  from: string | null;
  to: string;
  why: string;
}

/** Valor do Monday para exibir: datas em dd/mm/aaaa. */
const mondayValue = (v: string | null) => (!v ? "vazio" : /^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v.slice(0, 10)) : v);

/** Mudanças iguais em vários itens (ex.: o mesmo subelemento em todas as cases do grupo) viram uma linha só. */
function groupUpdates(list: MondayUpdate[]) {
  const groups = new Map<string, { key: string; first: MondayUpdate; ids: string[]; items: string[] }>();
  for (const u of list) {
    const key = [u.board, u.sub ?? "", u.column, u.from ?? "", u.to, u.why].join("|");
    const g = groups.get(key) ?? { key, first: u, ids: [], items: [] };
    g.ids.push(u.id);
    if (!g.items.includes(u.item)) g.items.push(u.item);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Atualizações do pedido para o Monday: prévia campo a campo e o botão "Enviar todos marcados" (manual, por enquanto).
 * O X marca a sugestão como incorreta: ela some até a leitura dos dados sugerir outra coisa naquele campo.
 */
function MondaySync({ code, reload }: { code: string; reload: () => void }) {
  const [data, setData] = useState<{ configured: boolean; items: number; live?: boolean; updates: MondayUpdate[]; dismissed?: MondayUpdate[] } | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ escritos: string[]; pulados: { id: string; motivo: string }[]; erros: { id: string; erro: string }[] } | null>(null);
  const load = () => api("GET", `/api/process/${code}/monday`).then(setData).catch(() => setData(null));
  useEffect(() => {
    setResult(null);
    load();
  }, [code]);
  // Sem nada a atualizar, o card não aparece (fica só para mostrar o resultado de uma sincronização).
  const dismissed = data?.dismissed ?? [];
  if (!data?.configured || !data.items || (!data.updates.length && !dismissed.length && !result)) return null;
  const chosen = data.updates.filter((u) => !off.has(u.id));
  const groups = groupUpdates(data.updates);
  const toggle = (ids: string[]) => {
    const next = new Set(off);
    const on = ids.some((id) => !off.has(id));
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setOff(next);
  };
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api("POST", `/api/process/${code}/monday/sync`, { items: chosen.map((u) => ({ id: u.id, from: u.from })) });
      setResult(r);
      toast(r.erros.length ? "Algumas atualizações falharam" : `${r.escritos.length} campo(s) atualizado(s) no Monday`, r.erros.length > 0);
      await load();
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
    setBusy(false);
  };
  const where = (u: MondayUpdate) => `[${u.board}] ${u.item}${u.sub ? ` › ${u.sub}` : ""} · ${u.column}: ${mondayValue(u.from)} → ${mondayValue(u.to)}`;
  const dismiss = async (ids: string[]) => {
    const list = data.updates.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, to: u.to, why: u.why, label: where(u) }));
    if (await attempt(() => api("POST", `/api/process/${code}/monday/dismiss`, { items: list }), "Sugestão marcada como incorreta: não volta enquanto for a mesma")) {
      await load();
      reload();
    }
  };
  const restore = async (ids: string[]) => {
    if (await attempt(() => api("POST", `/api/process/${code}/monday/restore`, { ids }), "A sugestão voltou")) await load();
  };
  const label = (id: string) => {
    const u = data.updates.find((x) => x.id === id);
    return u ? `${u.item}${u.sub ? ` › ${u.sub}` : ""} · ${u.column}` : id;
  };
  return html`<div class="section card" id="monday-sync">
    <div class="row">
      <h2 style=${{ margin: 0 }}>Atualizações para o Monday</h2>
      <span class="spacer"></span>
      ${data.updates.length > 0 && html`<button class="small primary with-icon" disabled=${busy || !chosen.length} onClick=${sync}><${Icon} name="send" spin=${busy} />Enviar todos marcados${chosen.length ? ` (${chosen.length})` : ""}</button>`}
    </div>
    <p class="small muted">${data.updates.length
      ? `O Freeway tem informação mais nova que o Monday em ${data.updates.length} campo(s) dos ${data.items} item(ns) ligado(s) a este pedido, contando os subelementos. Nada é escrito até você enviar. Se uma sugestão estiver errada, clique no X: ela não volta enquanto for a mesma.`
      : `Os ${data.items} item(ns) do Monday ligados a este pedido estão em dia com o Freeway.`}${data.live === false ? " (Monday fora do ar agora: prévia sem os subelementos.)" : ""}</p>
    ${groups.map(
      (g) => html`<label class="list-row" style=${{ cursor: "pointer", alignItems: "flex-start" }}>
        <input type="checkbox" checked=${g.ids.some((id) => !off.has(id))} onChange=${() => toggle(g.ids)} style=${{ marginTop: "3px" }} />
        <div style=${{ flex: 1, minWidth: 0 }}>
          <div><span class="faint small">[${g.first.board}]</span> ${g.first.sub ? html`Subelemento <b>${g.first.sub}</b> · ` : ""}<b>${g.first.column}:</b> <span class="muted">${mondayValue(g.first.from)}</span> → <b>${mondayValue(g.first.to)}</b></div>
          <div class="small faint">${g.first.why}</div>
          <div class="small muted" data-tip=${g.items.length > 3 ? g.items.join("\n") : undefined}>
            ${g.items.length === 1 ? g.items[0] : `${g.items.length} itens: ${g.items.slice(0, 3).join(", ")}${g.items.length > 3 ? ` +${g.items.length - 3}` : ""}`}
            ${g.items.length === 1 && g.first.url && html` <a href=${g.first.url} target="_blank" rel="noopener" onClick=${(e: Event) => e.stopPropagation()}>↗</a>`}
          </div>
        </div>
        <span onClick=${(e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        }}><${IconBtn} icon="x" variant="ghost" tip="Interpretação errada: esta atualização está incorreta e não deve ser sugerida de novo (volta só se a leitura dos dados sugerir outra coisa)" onClick=${() => dismiss(g.ids)} /></span>
      </label>`,
    )}
    ${dismissed.length > 0 &&
    html`<details class="small" style=${{ marginTop: "8px" }}>
      <summary class="muted">${dismissed.length} sugest${dismissed.length === 1 ? "ão marcada" : "ões marcadas"} como incorreta${dismissed.length === 1 ? "" : "s"}</summary>
      ${groupUpdates(dismissed).map(
        (g) => html`<div class="list-row" style=${{ alignItems: "flex-start" }}>
          <div style=${{ flex: 1, minWidth: 0 }}>
            <div class="muted"><span class="faint">[${g.first.board}]</span> ${g.first.sub ? `${g.first.sub} · ` : ""}${g.first.column}: ${mondayValue(g.first.from)} → ${mondayValue(g.first.to)}</div>
            <div class="faint">${g.first.why} · ${g.items.length === 1 ? g.items[0] : `${g.items.length} itens`}</div>
          </div>
          <button class="small" onClick=${() => restore(g.ids)}>Voltar a sugerir</button>
        </div>`,
      )}
    </details>`}
    ${result &&
    (result.pulados.length > 0 || result.erros.length > 0) &&
    html`<div class="small" style=${{ marginTop: "8px" }}>
      ${result.pulados.map((p) => html`<div class="muted">Pulado: ${label(p.id)} · ${p.motivo}</div>`)}
      ${result.erros.map((e) => html`<div style=${{ color: "var(--late)" }}>Erro: ${label(e.id)} · ${e.erro}</div>`)}
    </div>`}
  </div>`;
}

/** Leitura da IA: tudo o que o Freeway sabe do pedido (planilha, etapas, Monday, GDI, Drive, linha do tempo). */
function AiCard({ order, u, me, reload }: { order: OrderView; u: UnitView; me: Me; reload: () => void }) {
  const code = order.process_code;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const runAi = async (force: boolean) => {
    setBusy(true);
    try {
      const r = await api("POST", `/api/process/${code}/ia`, { force });
      setErr(r.error);
      if (r.called) reload();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  useEffect(() => {
    if (me.integrations.ai) runAi(false);
  }, [code]);
  if (!me.integrations.ai) return null;
  const ai = order.ai;
  const used = new Set(order.steps.flatMap((s) => (s.data?.tracking ? [String(s.data.tracking)] : [])));
  const useTracking = async (step: string, codigo: string, carrier: string | null) => {
    const patch: Record<string, unknown> = { tracking: codigo };
    if (step === "alinhamento") {
      patch.enabled = true;
      patch.carrier = carrier?.toLowerCase().includes("correios") ? "correios" : carrier?.toLowerCase().includes("fedex") ? "fedex" : "outro";
    }
    if (await attempt(() => api("PATCH", `/api/unit/${code}/step/${step}`, patch), "Rastreio registrado")) reload();
  };
  return html`<div class="section card" id="ai-card">
    <div class="row">
      <h2 style=${{ margin: 0 }}>Leitura da IA</h2><${AiIcon} tip="A IA da empresa lê tudo do pedido: planilha, etapas, Monday, Itapeva (GDI), Drive e linha do tempo" />
      <span class="spacer"></span>
      ${ai && html`<span class="small faint">${when(ai.created_at)}</span>`}
      <${IconBtn} icon="refresh" variant="ghost" spin=${busy} disabled=${busy} tip=${busy ? "A IA está lendo o pedido" : "Pedir à IA para ler o pedido de novo"} onClick=${() => runAi(true)} />
    </div>
    ${!ai && busy && html`<p class="small muted">A IA está lendo o pedido…</p>`}
    ${!ai && !busy && !err && html`<p class="small muted">Sem leitura ainda.</p>`}
    ${err && html`<p class="small" style=${{ color: "var(--late)" }}>Não foi possível ler agora: ${err}</p>`}
    ${ai &&
    html`${u.freight_total > 1
        ? html`<div style=${{ marginTop: "6px" }}><b>Este frete:</b> ${u.ai_note ?? "sem observação específica"}</div>
            <div class="small muted" style=${{ marginTop: "4px" }}>Pedido ${order.process_code} como um todo: ${ai.resumo}</div>`
        : html`<div style=${{ marginTop: "6px" }}>${ai.resumo}</div>`}
      ${ai.atencao && html`<div style=${{ marginTop: "6px" }}><span class="chip risk">Atenção</span> ${ai.atencao}</div>`}
      ${ai.rastreios.filter((r) => !used.has(r.codigo)).length > 0 &&
      html`<div style=${{ marginTop: "10px" }}>
        <div class="small faint">Rastreios citados</div>
        ${ai.rastreios
          .filter((r) => !used.has(r.codigo))
          .map(
            (r) => html`<div class="row small" style=${{ marginTop: "4px" }}>
              <span class="mono">${r.codigo}</span><span class="muted">${[r.transportadora, r.contexto].filter(Boolean).join(" · ")}</span>
              <span class="spacer"></span>
              <button class="small" onClick=${() => useTracking("amostra", r.codigo, r.transportadora)}>Usar na amostra</button>
              <button class="small" onClick=${() => useTracking("alinhamento", r.codigo, r.transportadora)}>Usar no alinhamento</button>
            </div>`,
          )}
      </div>`}
      <p class="small faint" style=${{ marginTop: "10px" }}>A IA só lê e sugere: o andamento das etapas continua vindo da planilha e do que é marcado no app.</p>`}
  </div>`;
}

const TIMELINE_STEP = 10;

/** Registros mais recentes primeiro; "Mostrar mais" abre de 10 em 10. */
function Timeline({ events }: { events: EventView[] }) {
  const [shown, setShown] = useState(TIMELINE_STEP);
  return html`<div class="card">
    <h2>Linha do tempo</h2>
    ${events.length === 0
      ? html`<p class="small faint">As mudanças da planilha e o que for feito no app aparecem aqui.</p>`
      : html`<ul class="timeline">${events.slice(0, shown).map(
          (e) => html`<li><span class="faint small">${when(e.created_at)}</span><span>${e.message} <span class="faint small">· ${e.actor}</span></span></li>`,
        )}</ul>
        ${events.length > shown &&
        html`<div class="row" style=${{ marginTop: "8px" }}>
          <button class="small with-icon" onClick=${() => setShown(shown + TIMELINE_STEP)}><${Icon} name="chevronDown" />Mostrar mais</button>
          <span class="small faint">${shown} de ${events.length}</span>
        </div>`}`}
  </div>`;
}

/** Placa de sinalização (ícone dos próximos passos). */
/** Item de lançamento: Status "Lançamento" na planilha de produtos. */
function isLaunch(i: ItemView): boolean {
  return /lan[cç]amento/i.test(i.product?.status ?? "");
}

function StarIcon() {
  return html`<span class="launch-star" data-tip="Lançamento (status na planilha de produtos)"><svg viewBox="0 0 24 24" fill="currentColor" aria-label="Lançamento">
    <path d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95L12 2.5z" />
  </svg></span>`;
}

function SignIcon() {
  return html`<svg class="sign-icon" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
    <path d="M48 97C48 98.6569 46.6569 100 45 100H37C35.3431 100 34 98.6569 34 97V63H48V97Z" />
    <path d="M71.8398 22C72.5976 22 73.3403 22.2156 73.9805 22.6211L97.6641 37.6211C100.144 39.1916 100.144 42.8084 97.6641 44.3789L73.9805 59.3789C73.3403 59.7844 72.5976 60 71.8398 60H7C4.79086 60 3 58.2091 3 56V26C3 23.7909 4.79086 22 7 22H71.8398Z" />
    <path d="M45 4C46.6569 4 48 5.34315 48 7V19H34V7C34 5.34315 35.3431 4 37 4H45Z" />
  </svg>`;
}

/** Próximos passos do pedido: card que abre e fecha, fechado de início. */
function NextStepsCard({ steps, reload, me, target }: { steps: NextStep[]; reload: () => void; me: Me; target: string }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return html`<div class="section card">
    <button class="collapse-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <${SignIcon} />
      <h2 style=${{ margin: 0 }}>Próximos passos</h2>
      <span class="chip">${steps.length}</span>
      <span class="spacer"></span>
      <${Icon} name=${open ? "chevronDown" : "chevronRight"} />
    </button>
    ${open && html`<div style=${{ marginTop: "8px" }}>${steps.map((ns) => html`<${NextStepRow} n=${ns} onDone=${reload} teamLabels=${me.teamLabels} target=${target} />`)}</div>`}
  </div>`;
}

function Documents({ docs }: { docs: any[] }) {
  if (!docs.length) return null;
  return html`<div style=${{ marginTop: "12px" }}>
    <h2>Documentos</h2>
    ${docs.map((d) => html`<div class="small"><a href=${`/api/documents/${d.id}`} target="_blank" rel="noopener">${d.filename}</a> <span class="faint">· ${d.kind.toUpperCase()} · ${fmtDate(d.uploaded_at.slice(0, 10), true)} · ${d.uploaded_by}</span></div>`)}
  </div>`;
}

function WatchButton({ order, reload }: { order: OrderView; reload: () => void }) {
  const watch = async () => {
    if (await attempt(() => api(order.watching ? "DELETE" : "POST", `/api/process/${order.process_code}/watch`), order.watching ? "Você deixou de seguir" : "Seguindo")) reload();
  };
  const split = order.units.length > 1;
  const tip = order.watching
    ? `Clique para deixar de seguir${split ? ` o pedido ${order.process_code} e seus ${order.units.length} fretes` : ""}`
    : `Passa a aparecer em Seguindo${split ? `, junto com os outros fretes do pedido ${order.process_code}` : ""}`;
  return html`<button class=${"small with-icon" + (order.watching ? "" : " primary")} data-tip=${tip} onClick=${watch}><${Icon} name="pin" filled=${!!order.watching} />${order.watching ? "Seguindo" : "Seguir"}</button>`;
}

type HoldState = "cancelado" | "on_hold";
const HOLD_ASK: Record<HoldState, { button: string; confirm: string; ok: string; icon: "ban" | "pause" }> = {
  on_hold: { button: "On hold", confirm: "Colocar on hold", ok: "Pedido on hold", icon: "pause" },
  cancelado: { button: "Cancelar pedido", confirm: "Cancelar pedido", ok: "Pedido cancelado", icon: "ban" },
};

/** Cancelar ou deixar on hold o pedido todo (com todos os fretes). Pede o motivo antes de gravar. */
function HoldControl({ o, reload }: { o: OrderView; reload: () => void }) {
  const [asking, setAsking] = useState<HoldState | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (o.hold?.state === "cancelado") return null;
  const scope = o.units.length > 1 ? ` Vale para o pedido ${o.process_code} todo, com os ${o.units.length} fretes.` : "";
  const save = async (state: HoldState) => {
    setBusy(true);
    const ok = await attempt(() => api("PUT", `/api/process/${o.process_code}/hold`, { state, note }), HOLD_ASK[state].ok);
    setBusy(false);
    if (ok) {
      setAsking(null);
      setNote("");
      reload();
    }
  };
  if (asking) {
    const a = HOLD_ASK[asking];
    return html`<form class="row hold-form" onSubmit=${(e: any) => { e.preventDefault(); save(asking); }}>
      <input value=${note} maxLength="300" autoFocus placeholder=${asking === "cancelado" ? "Motivo do cancelamento (opcional)" : "Motivo do on hold (opcional)"} aria-label="Motivo"
        onInput=${(e: any) => setNote(e.target.value)} onKeyDown=${(e: any) => e.key === "Escape" && setAsking(null)} />
      <button type="submit" class=${"small with-icon " + (asking === "cancelado" ? "danger" : "primary")} disabled=${busy} data-tip=${`Sem próximos passos nem cobranças até alguém reativar.${scope}`}><${Icon} name=${a.icon} />${a.confirm}</button>
      <button type="button" class="small ghost" onClick=${() => setAsking(null)}>Voltar</button>
    </form>`;
  }
  const btn = (state: HoldState, tip: string) =>
    html`<button class="small ghost with-icon" data-tip=${tip + scope} onClick=${() => setAsking(state)}><${Icon} name=${HOLD_ASK[state].icon} />${HOLD_ASK[state].button}</button>`;
  return html`${!o.hold && btn("on_hold", "Pausar o pedido: some de Em andamento e para de gerar próximos passos e cobranças.")}
    ${btn("cancelado", "Cancelar o pedido: some de Em andamento e para de gerar próximos passos e cobranças. Dá para reativar depois.")}`;
}

/** Faixa do pedido cancelado ou on hold no app, com o motivo e o botão de reativar. */
function HoldBanner({ o, reload }: { o: OrderView; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const h = o.hold;
  if (!h) return null;
  const reactivate = async () => {
    setBusy(true);
    const ok = await attempt(() => api("PUT", `/api/process/${o.process_code}/hold`, { state: null }), "Pedido reativado");
    setBusy(false);
    if (ok) reload();
  };
  const word = h.state === "cancelado" ? "cancelado" : "on hold";
  return html`<div class=${"hold-banner " + h.state}>
    <${Icon} name=${h.state === "cancelado" ? "ban" : "pause"} />
    <div style=${{ flex: 1, minWidth: 0 }}>
      <b>Pedido ${word}</b><span class="muted"> por ${h.by ?? "alguém"} em ${fmtDate(h.at.slice(0, 10))}</span>${h.note && html`<div>${h.note}</div>`}
      <div class="small faint">Enquanto estiver ${word}, o pedido não gera próximos passos nem cobranças${o.units.length > 1 ? `, em nenhum dos ${o.units.length} fretes` : ""}.</div>
    </div>
    <button class="small with-icon" disabled=${busy} onClick=${reactivate}><${Icon} name="play" />Reativar</button>
  </div>`;
}

// ---------- Página de um pedido (ou de um frete, quando o pedido foi dividido) ----------

/** Num pedido dividido, troca rápida entre os fretes (cada um é um pedido próprio). */
function OtherFreights({ order, u }: { order: OrderView; u: UnitView }) {
  if (u.freight_total < 2) return null;
  return html`<label class="row small muted" style=${{ gap: "6px" }}>
    Dividido em ${u.freight_total} fretes
    <select value=${u.display} aria-label="Ir para outro frete" onChange=${(e: any) => (location.hash = `#/p/${e.target.value}`)}>
      ${order.units.map((x) => html`<option value=${x.display}>${x.display}${x.situacao !== "andamento" ? ` · ${SITUACAO_LABEL[x.situacao].toLowerCase()}` : ""}</option>`)}
    </select>
  </label>`;
}

const TITLE_MAX = 120;

/** Título no cabeçalho do pedido, com o lápis para renomear. O título dado no app vale até alguém voltar ao da planilha. */
function TitleLine({ u, o, reload }: { u: UnitView; o: OrderView; reload: () => void }) {
  const auto = u.kind === "embarque" && u.products.length ? u.products.join(", ") : o.description ?? "";
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onlyThis = u.freight_total > 1 && u.kind === "embarque";
  const save = async (title: string) => {
    setBusy(true);
    const ok = await attempt(() => api("PUT", `/api/unit/${u.unit}/title`, { title }), title.trim() ? "Título salvo" : "Voltou ao título da planilha");
    setBusy(false);
    if (ok) {
      setEdit(null);
      reload();
    }
  };
  if (edit !== null) {
    return html`<form class="row" style=${{ marginTop: "6px", gap: "6px" }} onSubmit=${(e: any) => { e.preventDefault(); save(edit); }}>
      <input value=${edit} maxLength=${TITLE_MAX} autoFocus placeholder="Um nome curto para este pedido" aria-label="Título do pedido"
        onInput=${(e: any) => setEdit(e.target.value)} onKeyDown=${(e: any) => e.key === "Escape" && setEdit(null)} style=${{ flex: 1, minWidth: "200px" }} />
      <span class="small faint">${edit.length}/${TITLE_MAX}</span>
      <${IconBtn} type="submit" icon="check" variant="primary" tip=${onlyThis ? `Salvar o título (vale só para ${u.display})` : "Salvar o título"} disabled=${busy} />
      <${IconBtn} icon="x" tip="Cancelar" onClick=${() => setEdit(null)} />
      ${u.title && html`<${IconBtn} icon="reopen" tip="Voltar ao título da planilha" disabled=${busy} onClick=${() => save("")} />`}
    </form>`;
  }
  const tip = u.title ? `Título dado no app. Na planilha: ${auto.length > 300 ? auto.slice(0, 300) + "…" : auto || "sem descrição"}` : undefined;
  return html`<div class="row" style=${{ marginTop: "4px", gap: "4px", flexWrap: "nowrap", alignItems: "center" }}>
    <span data-tip=${tip} style=${{ minWidth: 0 }}>${u.title ?? auto}</span>
    <${IconBtn} icon="pencil" variant="ghost" tip="Renomear este pedido" onClick=${() => setEdit(u.title ?? (auto.length <= TITLE_MAX ? auto : ""))} />
  </div>`;
}

function UnitPage({ data, u, me, reload }: { data: { order: OrderView; events: EventView[]; documents: any[] }; u: UnitView; me: Me; reload: () => void }) {
  const o = data.order;
  const by = Object.fromEntries(u.steps.map((s) => [s.key, s]));
  const s = u.shipment;
  const n = u.freight_total;
  const card = (k: string) => html`<${StepCard} unit=${u.unit} orderCode=${o.process_code} freights=${n} s=${by[k]} reload=${reload} />`;
  const check = async (id: string, done: boolean) => {
    if (await attempt(() => api("POST", "/api/item-check", { id, done }))) reload();
  };
  const mark = async (id: string, kind: ItemKind, done: boolean) => {
    if (await attempt(() => api("POST", "/api/item-mark", { id, kind, done }), done ? "Marcado" : "Desmarcado")) reload();
  };
  const patch = async (step: string, p: Record<string, unknown>, ok: string) => {
    if (await attempt(() => api("PATCH", `/api/unit/${u.unit}/step/${step}`, p), ok)) reload();
  };
  const kv: [string, string | null][] = s
    ? [
        ["Modal", s.modal], ["Trader", s.trader], ["Armador", s.carrier_line], ["Ref. trading / BL", s.ref_bl],
        ["Quantidade", s.qty != null ? `${fmtQty(s.qty)} un.` : null], ["ETD China", fmtDate(s.etd)], ["ETA Santos", fmtDate(s.eta)],
        ["DI/DUIMP", fmtDate(s.duimp_at)], ["Draft DUIMP", s.draft_duimp], ["Canal", s.canal], ["Liberação SEFAZ", fmtDate(s.sefaz_at)],
        ["NF", s.nf], ["Previsão de entrega", fmtDate(s.delivery_forecast)], ["Entregue em", fmtDate(s.delivered_at)],
        ["Destino", s.destination ? DESTINATION_LABEL[s.destination] ?? s.destination : null],
      ]
    : [];
  const isBBI = u.order_kind === "BBI";
  const canCheck = isBBI && s?.status === "entregue";
  // Num pedido dividido, a linha do tempo mostra o que é deste frete e o que é do pedido original.
  const events = n > 1 ? data.events.filter((e) => !e.pi_number || e.pi_number === u.unit) : data.events;
  const docs = n > 1 ? data.documents.filter((d) => d.unit === u.unit || d.unit === o.process_code || !d.unit) : data.documents;

  return html`<div>
    <div class="card">
      <div class="row">
        <h1 class="mono">${u.display}</h1>
        <span class="chip">${o.kind}</span>
        <${FreightChip} u=${u} />
        ${s && html`<span class="chip">${s.status_label}</span>`}
        ${o.po_status && html`<span class=${"chip" + (o.po_status === "Finalizada" ? " ok" : "")} data-tip="Status da importação na planilha. O pedido só termina quando é lançado no site.">${IMPORT_STATUS_LABEL[o.po_status] ?? o.po_status}</span>`}
        ${o.source === "manual" && html`<span class="chip">Criado no app</span>`}
        ${o.removed_at && html`<span class="chip late">Saiu da planilha</span>`}
        <span class="spacer"></span>
        <${LaunchChip} u=${u} />
        <${SituacaoChip} u=${u} />
        <span class="pct">${pct(u.total)}</span>
      </div>
      <${TitleLine} u=${u} o=${o} reload=${reload} />
      <${HoldBanner} o=${o} reload=${reload} />
      <div class="small muted" style=${{ marginTop: "2px" }}>
        ${[o.supplier, o.category, o.buyer, o.po_date && `PO de ${fmtDate(o.po_date)}`, unitStatusLine(u)].filter(Boolean).join(" · ")}
      </div>
      <${Tracks} steps=${u.steps} />
      <div class="meta row small" style=${{ marginTop: "12px" }}>
        <span><span class="faint">Agora: </span>${u.current}</span>
        ${u.next_milestone && html`<span><span class="faint">Próximo marco: </span>${u.next_milestone.label} · ${fmtDate(u.next_milestone.date, true)}</span>`}
        <span class="spacer"></span>
        <${OtherFreights} order=${o} u=${u} />
        ${o.files_url && html`<a href=${o.files_url} target="_blank" rel="noopener" data-tip="Pasta Arquivos da planilha: invoice, packing list, BL…">Documentos de importação ↗</a>`}
        <${HoldControl} o=${o} reload=${reload} />
        <${WatchButton} order=${o} reload=${reload} />
      </div>
      <div class="small faint" style=${{ marginTop: "6px" }}>${o.watchers.length ? `Seguem: ${o.watchers.join(", ")}` : "Ninguém segue este pedido; sem seguidores, ele não gera notificações."}</div>
    </div>

    ${s &&
    html`<div class="section card">
      <h2 style=${{ margin: 0 }}>Dados do frete (planilha)</h2>
      <div class="kv" style=${{ marginTop: "8px" }}>${kv.filter(([, v]) => v).map(([k, v]) => html`<div><span>${k}</span>${v}</div>`)}</div>
      ${s.notes && html`<details style=${{ marginTop: "8px" }}><summary class="small">Observação da planilha</summary><div class="small muted" style=${{ whiteSpace: "pre-wrap", marginTop: "6px" }}>${s.notes}</div></details>`}
    </div>`}

    <${AiCard} order=${o} u=${u} me=${me} reload=${reload} />

    <${NextStepsCard} steps=${u.next_steps} reload=${reload} me=${me} target=${u.display} />

    <${MondaySync} code=${o.process_code} reload=${reload} />

    <div class="section">
      <div class="section-title"><h2>Desenvolvimento</h2><span class="spacer"></span><${Legend} /></div>
      <${DevBanner} info=${o.dev} others=${o.dev_others} />
      <div class="steps-grid">
        ${["ctr", "waitlist", "cores", "amostra_fab"].map((k) => html`<${DevStepCard} s=${by[k]} tasks=${o.dev?.tasks[k]} scope=${o.dev ? `dev:${o.dev.item_id}` : o.process_code} reload=${reload} />`)}
        <${StepCard} unit=${u.unit} orderCode=${o.process_code} freights=${n} s=${by.amostra} reload=${reload}>
          <${Samples} samples=${o.samples} code=${o.process_code} reload=${reload} />
          <${TaskList} tasks=${o.dev?.tasks.amostra} />
        </${StepCard}>
        <${StepCard} unit=${u.unit} orderCode=${o.process_code} freights=${n} s=${by.amostra_validacao} reload=${reload}>
          <${TaskList} tasks=${o.dev?.tasks.amostra_validacao} />
        </${StepCard}>
        <${DevStepCard} s=${by.goproduct} tasks=${o.dev?.tasks.goproduct} wide=${true}><${SkuCard} skus=${o.skus} reload=${reload} /></${DevStepCard}>
        <${StepCard} unit=${u.unit} orderCode=${o.process_code} freights=${n} s=${by.documentacao} reload=${reload}>
          <${TaskList} tasks=${o.dev?.tasks.documentacao} />
        </${StepCard}>
      </div>
      ${o.dev && o.dev.other_tasks.length > 0 && html`<div class="card" style=${{ marginTop: "10px" }}><${TaskList} tasks=${o.dev.other_tasks} title="Outras tarefas do lançamento no Monday (fora das etapas)" /></div>`}
    </div>

    <div class="section">
      <div class="section-title"><h2>Operação</h2></div>
      <div class="steps-grid">
        ${u.kind === "pedido" ? card("producao") : html`<${InfoCard} s=${by.producao} />`}
        ${card("alinhamento")}
        ${s
          ? html`<${InfoCard} s=${by.importacao} />
            <${InfoCard} s=${by.sefaz}>
              ${by.importacao.status === "done" && by.sefaz.status !== "done" && html`<div class="actions"><button class="small" data-tip="Use quando a planilha ainda não trouxe a data de liberação da SEFAZ. Avisa o time de Itapeva." onClick=${() => patch("sefaz", { manual_at: todayIso() }, "Desembaraço concluído")}>Marcar desembaraço concluído hoje</button></div>`}
            </${InfoCard}>
            <${FiscalCard} notes=${u.fiscal ?? []} status=${s.status} />
            <${InfoCard} s=${by.chegada} />
            ${card("fci")}
            ${isBBI &&
            html`<${InfoCard} s=${by.industrializacao}>
              ${canCheck && u.items.length === 0 && by.industrializacao.status !== "done" && html`<div class="actions"><button class="small" onClick=${() => patch("industrializacao", { done_at: todayIso() }, "Industrialização concluída")}>Concluir industrialização</button></div>`}
            </${InfoCard}>`}`
          : html`<div class="step-card"><div class="head"><h3>Importação</h3><span class="spacer"></span><span class="chip">Aguardando embarque</span></div>
              <div class="detail">Quando a planilha registrar o frete, importação, desembaraço e chegada aparecem aqui. Se o pedido for dividido em mais de um frete, cada frete vira um pedido próprio.</div></div>
            ${card("fci")}`}
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h2>Site</h2></div>
      <div class="steps-grid">${["mockups", "cadastro_site", "cadastro_wms", "lancamento"].map(card)}</div>
    </div>

    <div class="section">
      <div class="section-title"><h2>Marketing</h2></div>
      <div class="steps-grid">${["filmagem", "estampas", "marketing"].map(card)}</div>
    </div>

    <div class="section card">
      <div class="row"><h2 style=${{ margin: 0 }}>Itens${n > 1 ? " deste frete" : ""}</h2><span class="spacer"></span>
        <span class="small faint legend-cells"><span class="cell-ico done"><${Icon} name="checkCircle" /></span> concluído <span class="cell-ico doing"><${Pie} pct=${0.6} /></span> em andamento <span class="cell-ico todo"><${Icon} name="clock" /></span> aguardando · clique para marcar</span></div>
      ${u.items.some((i) => i.origin) && html`<p class="small faint" style=${{ margin: "4px 0 6px" }}>Itens da lista de SKUs (${u.items[0].origin}). Quando a planilha trouxer os itens do pedido, ela passa a valer.</p>`}
      ${u.items.length
        ? html`<${ItemsTable} items=${u.items} canInd=${isBBI && !!s && canCheck} onCheck=${check} onMark=${mark} />`
        : html`<p class="small faint">${s ? "Itens deste frete ainda não informados na planilha (sem packing list)." : "Sem itens na planilha."}</p>`}
      ${u.balance_qty > 0 && html`<p class="small muted" style=${{ marginTop: "8px" }}>${fmtQty(u.balance_qty)} un. do pedido original ainda não embarcaram; quando embarcarem, viram um novo frete.</p>`}
    </div>

    <div class="section grid2">
      <div class="card">
        <h2>Documentos e notas</h2>
        ${docs.length ? html`<${Documents} docs=${docs} />` : html`<p class="small faint">Nenhum documento anexado.</p>`}
        ${o.notes && html`<h3 style=${{ marginTop: "14px" }}>Notas da planilha (pedido)</h3><div class="small muted" style=${{ whiteSpace: "pre-wrap", marginTop: "4px" }}>${o.notes}</div>`}
      </div>
      <${Timeline} events=${events} />
    </div>
  </div>`;
}

/**
 * Rota #/p/BBI25137 ou #/p/BBI25205.2. Cada pedido tem uma página só: com um
 * frete, o código do pedido; dividido, um código por frete.
 */
export function ProcessRoute({ id, me, onChange }: { id: string; me: Me; onChange: () => void }) {
  const code = id.slice(0, 8);
  const [data, setData] = useState<{ order: OrderView; events: EventView[]; documents: any[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api("GET", `/api/process/${code}`)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    setData(null);
    load();
  }, [code]);
  const units = data?.order.units ?? [];
  // Endereço que não corresponde ao pedido como ele está hoje (ex.: BBI25137.1 com um frete só,
  // ou BBI25205 já dividido): leva para a página certa.
  const exact = units.find((x) => x.display === id);
  const target = exact ?? (units.length === 1 ? units[0] : units.find((x) => x.unit === id.replace(/\.(\d+)$/, "-$1")) ?? units.find((x) => !x.finalized) ?? units[0]);
  useEffect(() => {
    if (target && target.display !== id) history.replaceState(null, "", `#/p/${target.display}`);
  }, [target?.display, id]);
  const reload = () => {
    load();
    onChange();
  };
  if (err) return html`<${Empty} title=${err}><a href="#/buscar">Buscar outro pedido</a></${Empty}>`;
  if (!data) return html`<div class="loading">Carregando ${id}…</div>`;
  if (!target) return html`<${Empty} title=${`${id} não encontrado`}><a href="#/buscar">Buscar outro pedido</a></${Empty}>`;
  return html`<${UnitPage} data=${data} u=${target} me=${me} reload=${reload} />`;
}
