import { useEffect, useState } from "preact/hooks";
import type { LaunchCard, StepView } from "../src/shared/types";
import { STEPS } from "../src/domain/steps";
import { api, Bar, Empty, html, Legend, pct } from "./core";
import { Icon } from "./icons";

// Aba Galeria: lançamentos abertos em lista, agrupados pelo mês de lançamento do Monday, com foto e linhas de status.

interface Filters {
  mine: boolean;
  status: string;
  health: string;
}
const DEFAULTS: Filters = { mine: false, status: "", health: "" };
const FILTERS_KEY = "freeway.lancamentos.filtros";

function loadFilters(): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (saved && typeof saved === "object") return { ...DEFAULTS, ...saved };
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

function Thumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return html`<div class="launch-img" aria-hidden="true">
    ${src && !failed ? html`<img src=${src} alt="" loading="lazy" onError=${() => setFailed(true)} />` : html`<${Icon} name="star" />`}
  </div>`;
}

const TRACK_LABEL: [StepView["track"], string][] = [
  ["desenvolvimento", "Desenvolvimento"],
  ["operacao", "Operação"],
  ["site", "Site"],
  ["marketing", "Marketing"],
];

/**
 * As trilhas, uma por linha (Desenvolvimento, Operação, Site e Marketing), com o nome de cada etapa embaixo do seu trecho.
 * Lançamento ainda sem pedido mostra Operação, Site e Marketing vazias, para as colunas ficarem alinhadas entre as linhas.
 */
function Strip({ steps }: { steps: StepView[] }) {
  return html`<div class="strip">
    ${TRACK_LABEL.map(([key, label]) => {
      const own = steps.filter((s) => s.track === key);
      const list: StepView[] = own.length
        ? own
        : STEPS.filter((d) => d.track === key).map((d) => ({ key: d.key, label: d.label, short: d.short, track: d.track, scope: d.scope, status: "todo", progress: 0, detail: "Ainda sem pedido" }));
      return html`<div class=${`strip-track track-${key}`}>
        <div class="strip-name">${label}</div>
        <${Bar} steps=${list} thin=${true} />
      </div>`;
    })}
  </div>`;
}

/**
 * Uma linha da lista, em duas faixas: em cima, foto, nome, pedido, categoria e responsáveis (à esquerda) e o "Agora" (à direita);
 * embaixo, as barras de status (uma trilha por linha) e o percentual. A linha inteira abre o desenvolvimento.
 */
function Row({ c }: { c: LaunchCard }) {
  const meta = [c.tipo, c.people.join(", ")].filter(Boolean).join(" · ");
  return html`<a class="launch-row" href=${`#/dev/${c.item_id}`}>
    <div class="launch-top">
      <${Thumb} src=${c.img} />
      <div class="launch-main">
        <div class="launch-head">
          <b class="launch-name">${c.name}</b>
          ${c.process_codes.map((p) => html`<span class="chip accent">${p}</span>`)}
          ${c.watching && html`<span class="faint" data-tip="Você segue este lançamento"><${Icon} name="pin" filled /></span>`}
        </div>
        ${meta && html`<div class="small muted launch-meta">${meta}</div>`}
      </div>
      <div class="small launch-now"><span class="faint">Agora: </span>${c.current}</div>
    </div>
    <div class="launch-progress">
      <${Strip} steps=${c.steps} />
      <span class="pct">${pct(c.total)}</span>
    </div>
  </a>`;
}

export function LaunchGallery() {
  const [data, setData] = useState<{ cards: LaunchCard[]; month: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(loadFilters);
  const [q, setQ] = useState("");
  const [past, setPast] = useState(false);
  useEffect(() => {
    api("GET", "/api/lancamentos").then(setData).catch((e) => setErr(e.message));
  }, []);
  if (err) return html`<${Empty} title="Não foi possível carregar"><p>${err}</p></${Empty}>`;
  if (!data) return html`<div class="loading">Montando a galeria de lançamentos…</div>`;

  const set = (p: Partial<Filters>) => {
    const next = { ...f, ...p };
    setF(next);
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch {
      // sem armazenamento: o filtro vale só nesta visita
    }
  };
  const words = fold(q).split(/\s+/).filter(Boolean);
  const shown = data.cards.filter((c) => {
    if (f.mine && !c.watching && !c.mine) return false;
    if (f.status && c.launch_status !== f.status) return false;
    if (f.health && c.health !== f.health) return false;
    if (words.length) {
      const text = fold([c.name, c.group, c.tipo, c.stage, c.launch_status, c.people.join(" "), c.process_codes.join(" ")].filter(Boolean).join(" "));
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
  const byMonth = new Map<string, LaunchCard[]>();
  for (const c of shown) {
    const k = c.month ?? "";
    byMonth.set(k, [...(byMonth.get(k) ?? []), c]);
  }
  const months = [...byMonth.keys()].filter(Boolean).sort();
  const earlier = months.filter((m) => m < data.month);
  const visible = [...(past ? earlier : []), ...months.filter((m) => m >= data.month), ...(byMonth.has("") ? [""] : [])];
  const earlierCount = earlier.reduce((n, m) => n + (byMonth.get(m)?.length ?? 0), 0);
  const statuses = [...new Set(data.cards.map((c) => c.launch_status).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "pt"));
  const filtered = f.mine || !!f.status || !!f.health;

  return html`<div class="launch-cal">
    <div class="row"><h1>Galeria</h1><span class="spacer"></span><${Legend} /></div>
    <p class="muted small" style=${{ marginTop: 0 }}>Lançamentos abertos nos quadros Launches do Monday, pelo mês de lançamento (o grupo do item). Clique para ver os detalhes do desenvolvimento.</p>
    <div class="row small muted" style=${{ marginBottom: "8px" }}>
      <div class="search-box search-home">
        <${Icon} name="search" />
        <input placeholder="Buscar lançamento, pessoa, tipo, pedido…" value=${q} onInput=${(e: any) => setQ(e.target.value)} onKeyDown=${(e: KeyboardEvent) => e.key === "Escape" && setQ("")} />
        ${q && html`<button class="clear" title="Limpar busca" onClick=${() => setQ("")}>×</button>`}
      </div>
      <span>${shown.length} de ${data.cards.length} lançamentos</span>
    </div>
    <div class="filters">
      <button type="button" class=${"fchip" + (f.mine ? " on" : "")} aria-pressed=${f.mine} data-tip="Os que você segue ou em que está na coluna People" onClick=${() => set({ mine: !f.mine })}><${Icon} name="pin" filled=${f.mine} />Só os meus</button>
      ${statuses.length > 0 &&
      html`<select value=${f.status} aria-label="Status do lançamento" onChange=${(e: any) => set({ status: e.target.value })}>
        <option value="">Qualquer status</option>
        ${statuses.map((s) => html`<option value=${s}>${s}</option>`)}
      </select>`}
      <select value=${f.health} aria-label="Prazo" onChange=${(e: any) => set({ health: e.target.value })}>
        <option value="">Qualquer prazo</option>
        <option value="late">Atrasados</option>
        <option value="risk">Em risco</option>
        <option value="ok">No prazo</option>
      </select>
      ${(filtered || q) &&
      html`<button class="link" type="button" onClick=${() => {
        set(DEFAULTS);
        setQ("");
      }}>Limpar filtros</button>`}
    </div>
    ${earlier.length > 0 &&
    html`<button class="small with-icon launch-past" type="button" onClick=${() => setPast(!past)}>
      <${Icon} name=${past ? "chevronDown" : "chevronRight"} />${past ? "Esconder" : "Mostrar"} ${earlier.length} ${earlier.length === 1 ? "mês anterior" : "meses anteriores"} (${earlierCount} lançamento${earlierCount === 1 ? "" : "s"} ainda aberto${earlierCount === 1 ? "" : "s"})
    </button>`}
    ${visible.length === 0
      ? html`<div class="card muted">Nenhum lançamento${filtered || q ? " com esses filtros" : ""}.</div>`
      : visible.map((m) => {
          const list = byMonth.get(m) ?? [];
          const late = list.filter((c) => c.health === "late").length;
          const risk = list.filter((c) => c.health === "risk").length;
          return html`<section class=${"launch-month" + (m === data.month ? " now" : "") + (m && m < data.month ? " past" : "")}>
            <div class="section-title">
              <h2>${m ? monthLabel(m) : "Sem mês de lançamento"}</h2>
              ${m === data.month && html`<span class="chip accent">Este mês</span>`}
              <span class="small faint">${list.length} lançamento${list.length === 1 ? "" : "s"}</span>
              ${late > 0 && html`<span class="chip late">${late} atrasado${late === 1 ? "" : "s"}</span>`}
              ${risk > 0 && html`<span class="chip risk">${risk} em risco</span>`}
            </div>
            ${!m && html`<p class="small faint" style=${{ marginTop: "-4px" }}>O grupo do item no Monday não diz o mês (ex.: ${[...new Set(list.map((c) => c.group ?? "sem grupo"))].slice(0, 3).join(", ")}).</p>`}
            <div class="card launch-list">${list.map((c) => html`<${Row} c=${c} />`)}</div>
          </section>`;
        })}
  </div>`;
}
