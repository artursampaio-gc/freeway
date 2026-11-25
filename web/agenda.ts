import { useEffect, useState } from "preact/hooks";
import type { AgendaEvent } from "../src/shared/types";
import { STEP_BY_KEY } from "../src/domain/steps";
import { fmtDate } from "../src/shared/labels";
import { api, html, toast, todayIso } from "./core";
import { Icon, IconBtn } from "./icons";

// Aba Agenda: datas dos pedidos em andamento (e dos seguidos) e tarefas dos desenvolvimentos abertos.

type Group = AgendaEvent["group"];
type Track = AgendaEvent["track"];

interface AgendaFilters {
  groups: Group[];
  state: "" | "pendente" | "late" | "done";
  track: "" | Track;
  key: string;
  company: string;
  supplier: string;
  mine: boolean;
  view: "mes" | "lista";
}

const GROUPS: [Group, string, string][] = [
  ["logistica", "Logística", "Embarque, chegada ao porto, DUIMP, SEFAZ e entrega no CD (planilha de importação)"],
  ["prazo", "Prazos das etapas", "Prazo de cada etapa ainda aberta do pedido (produção, FCI, mockups, lançamento…)"],
  ["tarefa", "Tarefas de desenvolvimento", "Tarefas dos lançamentos no Monday (quadros Launches)"],
];
const TRACKS: [Track, string][] = [
  ["desenvolvimento", "Desenvolvimento"],
  ["operacao", "Operação"],
  ["site", "Site"],
  ["marketing", "Marketing"],
];
const STATE_LABEL: Record<AgendaEvent["state"], string> = { done: "Concluído", late: "Atrasado", risk: "Em risco", todo: "Previsto" };
const STATE_CHIP: Record<AgendaEvent["state"], string> = { done: "ok", late: "late", risk: "risk", todo: "" };
/** Datas da planilha que já aconteceram são "realizadas" (ou "data passou", sem o frete avançar); tarefas e prazos, "concluídos". */
const stateText = (e: AgendaEvent) => (e.group === "logistica" && e.state === "done" ? "Realizado" : e.group === "logistica" && e.state === "risk" ? "Data passou" : STATE_LABEL[e.state]);
// Por padrão, só o que a pessoa segue (pedidos e desenvolvimentos); "Só o que eu sigo" desligado mostra tudo em andamento.
const DEFAULTS: AgendaFilters = { groups: ["logistica", "prazo", "tarefa"], state: "", track: "", key: "", company: "", supplier: "", mine: true, view: "mes" };
const FILTERS_KEY = "freeway.agenda.filtros";
const WEEK = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function loadFilters(): AgendaFilters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (saved && Array.isArray(saved.groups) && saved.groups.length) return { ...DEFAULTS, ...saved };
  } catch {
    // sem armazenamento: fica o padrão
  }
  return DEFAULTS;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("pt-BR", { month: "long", timeZone: "UTC" });
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${y}`;
};
const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "long", timeZone: "UTC" });

/** Dias da grade do mês (de domingo a sábado), com os dias do mês anterior e do seguinte para fechar as semanas. */
function monthDays(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = new Date(first.getTime() - first.getUTCDay() * 86400000);
  const last = new Date(Date.UTC(y, m, 0));
  const end = new Date(last.getTime() + (6 - last.getUTCDay()) * 86400000);
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const keyLabel = (e: AgendaEvent) => (e.group === "tarefa" ? `Tarefas: ${STEP_BY_KEY[e.key]?.label ?? "outras"}` : e.label.replace(/^Previsão de entrega no CD|^Entregue no CD/, "Entrega no CD"));

function Pill({ e }: { e: AgendaEvent }) {
  const text = e.group === "tarefa" ? `${e.unit}: ${e.label}` : `${e.unit} · ${e.label}`;
  return html`<a class=${`cal-pill ${e.group} ${e.state}`} href=${e.href} title=${`${text}${e.title ? ` · ${e.title}` : ""} · ${stateText(e)}`} onClick=${(ev: Event) => ev.stopPropagation()}>${text}</a>`;
}

function EventRow({ e, showDate }: { e: AgendaEvent; showDate?: boolean }) {
  const meta = [e.title, e.supplier, e.who].filter(Boolean).join(" · ");
  return html`<div class="list-row cal-row">
    ${showDate && html`<span class="small faint cal-row-date">${fmtDate(e.date, true)}</span>`}
    <span class=${`cal-dot ${e.group}`} aria-hidden="true"></span>
    <div style=${{ flex: 1, minWidth: 0 }}>
      <div><b>${e.label}</b> <a class="mono" href=${e.href}>${e.unit}</a>${e.watching && html` <span class="faint" data-tip="Você segue"><${Icon} name="pin" filled /></span>`}</div>
      ${meta && html`<div class="small faint cal-meta">${meta}</div>`}
    </div>
    <span class=${`chip ${STATE_CHIP[e.state]}`}>${stateText(e)}</span>
  </div>`;
}

export function AgendaPage() {
  // Um mês por vez (a grade inteira, com os dias das pontas); o que já veio fica guardado enquanto a aba está aberta.
  const [cache, setCache] = useState<Record<string, AgendaEvent[]>>({});
  const [todayStr, setToday] = useState<string>(todayIso);
  const [f, setF] = useState<AgendaFilters>(loadFilters);
  const [q, setQ] = useState("");
  const [ym, setYm] = useState<string>(() => todayIso().slice(0, 7));
  const [sel, setSel] = useState<string | null>(todayIso);
  useEffect(() => {
    if (cache[ym]) return;
    const days = monthDays(ym);
    api("GET", `/api/agenda?from=${days[0]}&to=${days[days.length - 1]}`)
      .then((d) => {
        setToday(d.today);
        setCache((c) => ({ ...c, [ym]: d.events }));
      })
      .catch((e) => toast(e.message, true));
  }, [ym]);
  const loaded = cache[ym] ?? null;
  const all = loaded ?? [];

  const set = (p: Partial<AgendaFilters>) => {
    const next = { ...f, ...p };
    setF(next);
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch {
      // sem armazenamento: o filtro vale só nesta visita
    }
  };
  const toggleGroup = (g: Group) => {
    const groups = f.groups.includes(g) ? f.groups.filter((x) => x !== g) : [...f.groups, g];
    set({ groups: groups.length ? groups : DEFAULTS.groups });
  };
  const clear = () => {
    set({ ...DEFAULTS, view: f.view });
    setQ("");
  };

  const words = fold(q).split(/\s+/).filter(Boolean);
  // Todos os filtros, menos o de tipo (as contagens dos chips de tipo usam este conjunto).
  const base = all.filter((e) => {
    if (f.mine && !e.watching) return false;
    if (f.state === "pendente" && e.state === "done") return false;
    if (f.state === "late" && e.state !== "late") return false;
    if (f.state === "done" && e.state !== "done") return false;
    if (f.track && e.track !== f.track) return false;
    if (f.key && keyLabel(e) !== f.key) return false;
    if (f.company && e.company !== f.company) return false;
    if (f.supplier && e.supplier !== f.supplier) return false;
    if (words.length) {
      const text = fold([e.unit, e.label, e.title, e.supplier, e.who].filter(Boolean).join(" "));
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
  const shown = base.filter((e) => f.groups.includes(e.group));
  const inMonth = (e: AgendaEvent) => e.date.startsWith(ym);
  const countGroup = (g: Group) => base.filter((e) => e.group === g && inMonth(e)).length;
  const byDay = new Map<string, AgendaEvent[]>();
  for (const e of shown) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const monthEvents = shown.filter(inMonth);

  const keys = [...new Set(all.map(keyLabel))].sort((a, b) => a.localeCompare(b, "pt"));
  const suppliers = [...new Set(all.map((e) => e.supplier).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "pt"));
  const companies = [...new Set(all.map((e) => e.company).filter(Boolean) as string[])].sort();
  const filtered = f.groups.length !== DEFAULTS.groups.length || !!f.state || !!f.track || !!f.key || !!f.company || !!f.supplier || f.mine !== DEFAULTS.mine;
  const go = (n: number) => {
    const next = shiftMonth(ym, n);
    setYm(next);
    setSel(next === todayStr.slice(0, 7) ? todayStr : `${next}-01`);
  };
  const today = () => {
    setYm(todayStr.slice(0, 7));
    setSel(todayStr);
  };
  const late = monthEvents.filter((e) => e.state === "late").length;
  const selEvents = sel ? byDay.get(sel) ?? [] : [];

  return html`<div class="calendar">
    <div class="row"><h1>Agenda</h1><span class="spacer"></span>
      <div class="cal-nav">
        <${IconBtn} icon="chevronLeft" tip="Mês anterior" onClick=${() => go(-1)} />
        <b class="cal-month">${monthLabel(ym)}</b>
        <${IconBtn} icon="chevronRight" tip="Próximo mês" onClick=${() => go(1)} />
        <button class="small" onClick=${today}>Hoje</button>
      </div>
      <div class="fchips" role="group" aria-label="Visão">
        <button type="button" class=${"fchip" + (f.view === "mes" ? " on" : "")} aria-pressed=${f.view === "mes"} onClick=${() => set({ view: "mes" })}>Mês</button>
        <button type="button" class=${"fchip" + (f.view === "lista" ? " on" : "")} aria-pressed=${f.view === "lista"} onClick=${() => set({ view: "lista" })}>Lista</button>
      </div>
    </div>
    <p class="muted small" style=${{ marginTop: 0 }}>${f.mine ? "Datas dos pedidos e desenvolvimentos que você segue (desligue “Só o que eu sigo” para ver todos em andamento)." : "Datas de todos os pedidos em andamento e as tarefas dos desenvolvimentos abertos."} ${monthEvents.length} evento${monthEvents.length === 1 ? "" : "s"} neste mês${late ? html`, <span style=${{ color: "var(--late)" }}>${late} atrasado${late === 1 ? "" : "s"}</span>` : ""}.</p>

    <div class="row small muted" style=${{ marginBottom: "8px" }}>
      <div class="search-box search-home">
        <${Icon} name="search" />
        <input placeholder="Buscar pedido, produto, fornecedor, responsável…" value=${q} onInput=${(e: any) => setQ(e.target.value)} onKeyDown=${(e: KeyboardEvent) => e.key === "Escape" && setQ("")} />
        ${q && html`<button class="clear" title="Limpar busca" onClick=${() => setQ("")}>×</button>`}
      </div>
    </div>
    <div class="filters">
      <div class="fchips" role="group" aria-label="Tipo">
        ${GROUPS.map(
          ([g, label, tip]) => html`<button type="button" class=${"fchip cal-g " + g + (f.groups.includes(g) ? " on" : "")} aria-pressed=${f.groups.includes(g)} data-tip=${tip} onClick=${() => toggleGroup(g)}>
            <span class=${`cal-dot ${g}`} aria-hidden="true"></span>${label}<span class="n">${countGroup(g)}</span>
          </button>`,
        )}
      </div>
      <select value=${f.state} aria-label="Situação" onChange=${(e: any) => set({ state: e.target.value })}>
        <option value="">Qualquer situação</option>
        <option value="pendente">Pendentes</option>
        <option value="late">Atrasados</option>
        <option value="done">Concluídos e realizados</option>
      </select>
      <select value=${f.track} aria-label="Frente" onChange=${(e: any) => set({ track: e.target.value })}>
        <option value="">Todas as frentes</option>
        ${TRACKS.map(([t, label]) => html`<option value=${t}>${label}</option>`)}
      </select>
      <select value=${f.key} aria-label="Marco" onChange=${(e: any) => set({ key: e.target.value })}>
        <option value="">Todos os marcos</option>
        ${keys.map((k) => html`<option value=${k}>${k}</option>`)}
      </select>
      ${companies.length > 1 &&
      html`<select value=${f.company} aria-label="Empresa" onChange=${(e: any) => set({ company: e.target.value })}>
        <option value="">${companies.join(" e ")}</option>
        ${companies.map((k) => html`<option value=${k}>Só ${k}</option>`)}
      </select>`}
      ${suppliers.length > 1 &&
      html`<select value=${f.supplier} aria-label="Fornecedor" onChange=${(e: any) => set({ supplier: e.target.value })}>
        <option value="">Todos os fornecedores</option>
        ${suppliers.map((s) => html`<option value=${s}>${s}</option>`)}
      </select>`}
      <button type="button" class=${"fchip" + (f.mine ? " on" : "")} aria-pressed=${f.mine} onClick=${() => set({ mine: !f.mine })}><${Icon} name="pin" filled=${f.mine} />Só o que eu sigo</button>
      ${(filtered || q) && html`<button class="link" type="button" onClick=${clear}>Limpar filtros</button>`}
    </div>

    ${!loaded
      ? html`<div class="card"><div class="loading">Carregando ${monthLabel(ym).toLowerCase()}…</div></div>`
      : f.view === "mes"
      ? html`<div class="card cal-card">
          <div class="cal-grid" role="grid" aria-label=${monthLabel(ym)}>
            ${WEEK.map((w) => html`<div class="cal-wd" role="columnheader">${w}</div>`)}
            ${monthDays(ym).map((d) => {
              const evs = byDay.get(d) ?? [];
              const out = !d.startsWith(ym);
              const lateHere = evs.some((e) => e.state === "late");
              return html`<div role="gridcell" tabindex="0" aria-selected=${sel === d}
                class=${["cal-day", out ? "out" : "", d === todayStr ? "today" : "", sel === d ? "sel" : "", evs.length ? "has" : ""].filter(Boolean).join(" ")}
                onClick=${() => setSel(d)} onKeyDown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && setSel(d)}>
                <div class="cal-num"><span>${Number(d.slice(8))}</span>${evs.length > 0 && html`<span class=${"cal-count" + (lateHere ? " late" : "")}>${evs.length}</span>`}</div>
                <div class="cal-pills">
                  ${evs.slice(0, 3).map((e) => html`<${Pill} e=${e} />`)}
                  ${evs.length > 3 && html`<span class="cal-more">+${evs.length - 3} mais</span>`}
                </div>
              </div>`;
            })}
          </div>
        </div>
        ${sel &&
        html`<div class="card section">
          <div class="row"><h2 style=${{ margin: 0 }}>${fmtDate(sel)} · ${weekday(sel)}</h2><span class="spacer"></span><span class="small faint">${selEvents.length} evento${selEvents.length === 1 ? "" : "s"}</span></div>
          ${selEvents.length === 0
            ? html`<p class="small faint">Nada neste dia${filtered || q ? " com esses filtros" : ""}.</p>`
            : selEvents.map((e) => html`<${EventRow} e=${e} />`)}
        </div>`}`
      : html`<div class="card">
          ${monthEvents.length === 0
            ? html`<p class="small faint">Nada neste mês${filtered || q ? " com esses filtros" : ""}.</p>`
            : [...new Set(monthEvents.map((e) => e.date))].map(
                (d) => html`<div class=${"cal-list-day" + (d === todayStr ? " today" : "") + (d < todayStr ? " past" : "")}>
                  <div class="cal-list-head"><b>${fmtDate(d)}</b> <span class="faint">${weekday(d)}${d === todayStr ? " · hoje" : ""}</span></div>
                  ${(byDay.get(d) ?? []).map((e) => html`<${EventRow} e=${e} />`)}
                </div>`,
              )}
        </div>`}
  </div>`;
}
