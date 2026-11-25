import { h, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import type { ColorSwatch, StepView } from "../src/shared/types";
import { fmtDate } from "../src/shared/labels";

export const html = htm.bind(h);

// ---------- Infra ----------

function reportError(message: string) {
  fetch("/api/client-error", { method: "POST", body: message.slice(0, 2000) }).catch(() => {});
}
window.addEventListener("error", (e) => reportError(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => reportError(`unhandled: ${(e.reason as Error)?.stack ?? e.reason}`));

export async function api<T = any>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: raw ? { "Content-Type": "application/octet-stream" } : body !== undefined ? { "Content-Type": "application/json" } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) {
    location.reload();
    throw new Error("Sessão expirada");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data as T;
}

let showToast: (msg: string, err?: boolean) => void = () => {};
export function toast(msg: string, err = false) {
  showToast(msg, err);
}

export function Toast() {
  const [t, setT] = useState<{ msg: string; err: boolean } | null>(null);
  const timer = useRef<number>();
  showToast = (msg, err = false) => {
    setT({ msg, err });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), err ? 6000 : 3000);
  };
  return t ? html`<div class=${"toast" + (t.err ? " err" : "")} role="status">${t.msg}</div>` : null;
}

export async function attempt(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
    return true;
  } catch (e) {
    toast((e as Error).message, true);
    return false;
  }
}

export const todayIso = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export const pct = (n: number) => `${Math.round(n * 100)}%`;

export function utcToBr(iso: string): string {
  return new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(11, 16);
}

export function when(iso: string): string {
  return `${fmtDate(iso.slice(0, 10), true)} ${utcToBr(iso)}`;
}

export function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export interface Me {
  email: string;
  isAdmin: boolean;
  teams: string[];
  unread: number;
  teamLabels: Record<string, string>;
  integrations: { sheets: boolean; fedex: boolean; ai: boolean; monday: boolean; itapeva: boolean; slack?: boolean };
  lastAutoSync: { source: string; ran_at: string; ok: number } | null;
}

// ---------- Componentes base ----------

const HEALTH: Record<string, [string, string]> = { ok: ["ok", "No prazo"], risk: ["risk", "Em risco"], late: ["late", "Atrasado"] };

export function HealthChip({ health }: { health: string }) {
  const [cls, label] = HEALTH[health] ?? HEALTH.ok;
  return html`<span class=${"chip " + cls}>${label}</span>`;
}

export const STATUS_CHIP: Record<string, [string, string]> = {
  done: ["ok", "Concluída"],
  doing: ["accent", "Em andamento"],
  todo: ["", "Não iniciada"],
  risk: ["risk", "Em risco"],
  late: ["late", "Atrasada"],
  blocked: ["late", "Bloqueada"],
  na: ["", "Não se aplica"],
};

export function StatusChip({ status }: { status: string }) {
  const [cls, label] = STATUS_CHIP[status] ?? ["", status];
  return html`<span class=${"chip " + cls}>${label}</span>`;
}

export function fillWidth(s: StepView): string {
  if (s.status === "done") return "100%";
  if (s.status === "todo" || s.status === "na") return "0%";
  const min = s.status === "doing" ? 0.06 : 0.15;
  return `${Math.round(Math.max(min, s.progress) * 100)}%`;
}

export function Bar({ steps, labels = true, thin = false }: { steps: StepView[]; labels?: boolean; thin?: boolean }) {
  return html`<div class=${"bar" + (thin ? " thin" : "")}>
    ${steps.map(
      (s) => html`<div class=${"seg" + (s.status === "na" ? " na" : "")} title=${`${s.label}: ${s.detail || STATUS_CHIP[s.status]?.[1]}${s.inherited ? " (do pedido)" : ""}`}>
        <div class="track"><div class=${"fill st-" + s.status} style=${{ width: fillWidth(s) }}></div></div>
        ${labels && html`<div class="lbl">${s.short}</div>`}
      </div>`,
    )}
  </div>`;
}

const TRACKS: [string, string, string][] = [
  ["desenvolvimento", "Desenvolvimento", "Desenv."],
  ["operacao", "Operação", "Operação"],
  ["site", "Site", "Site"],
  ["marketing", "Marketing", "Marketing"],
];

/** As trilhas de um processo (Desenvolvimento, Operação, Site e Marketing), uma em cada andar. */
export function Tracks({ steps, compact = false, labels = !compact }: { steps: StepView[]; compact?: boolean; labels?: boolean }) {
  return html`<div class=${"tracks" + (compact ? " compact" : "") + (labels ? " labeled" : "")}>
    ${TRACKS.map(([key, label, short]) => {
      const list = steps.filter((s) => s.track === key);
      if (!list.length) return null;
      return html`<div class=${`track-col track-${key}`}>
        <div class="track-name">${compact ? short : label}</div>
        <${Bar} steps=${list} labels=${labels} thin=${compact} />
      </div>`;
    })}
  </div>`;
}

/**
 * Quadradinho da cor, como no GoProduct: com dois ou mais pantones, fracionado (em fatias a partir de baixo, no sentido
 * horário: a primeira cor à esquerda); sem isso, a miniatura da textura, se houver; senão, a cor lisa.
 */
export function Swatch({ c }: { c: ColorSwatch }) {
  const [failed, setFailed] = useState(false);
  const hs = (c.hexes ?? []).filter(Boolean);
  if (hs.length >= 2) {
    const step = 100 / hs.length;
    const stops = hs.map((h, i) => `${h} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`).join(", ");
    return html`<i class="swatch" style=${{ background: `conic-gradient(from 180deg, ${stops})` }}></i>`;
  }
  if (c.tex && !failed) return html`<i class="swatch tex" style=${{ background: c.hex ?? "var(--surface-2)" }}><img src=${c.tex} alt="" loading="lazy" onError=${() => setFailed(true)} /></i>`;
  return html`<i class="swatch" style=${{ background: c.hex ?? hs[0] ?? "var(--surface-2)" }}></i>`;
}

export function Legend() {
  return html`<div class="legend">
    <span><i class="st-done"></i>Concluída</span>
    <span><i class="st-doing"></i>Em andamento</span>
    <span><i class="st-risk"></i>Em risco</span>
    <span><i class="st-late"></i>Atrasada ou bloqueada</span>
    <span><i style=${{ background: "var(--todo)" }}></i>Não iniciada</span>
  </div>`;
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return html`<div class="card empty"><h2>${title}</h2>${children}</div>`;
}

export function linkify(text: string) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return parts.map((p) => (/^https?:\/\//.test(p) ? html`<a href=${p} target="_blank" rel="noopener">${p}</a>` : p));
}
