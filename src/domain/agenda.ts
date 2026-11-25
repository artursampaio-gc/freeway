import type { DB } from "../env";
import { all, todayBR } from "../db/q";
import type { AgendaEvent, DevProjectView, DevTask, OrderView, StepView, UnitView } from "../shared/types";
import { devProjects, markWatching } from "./dev";
import { loadViews } from "./view";

// Aba Agenda: as datas dos pedidos em andamento (e dos que a pessoa segue) e dos desenvolvimentos abertos.
// Nada é guardado: tudo sai das mesmas telas de pedido e de desenvolvimento.

/** Pedidos em andamento: os mesmos de Pedidos → "Em andamento" (nem cancelados nem já lançados). */
async function activeCodes(db: DB, user: string): Promise<string[]> {
  const launched = `json_extract(ss.data, '$.done_at') IS NOT NULL`;
  const rows = await all<{ process_code: string }>(
    db,
    `SELECT o.process_code FROM orders o
      WHERE o.removed_at IS NULL AND (
        EXISTS (SELECT 1 FROM watchers w WHERE w.process_code = o.process_code AND w.user_email = ?)
        OR (
          COALESCE(o.po_status, '') <> 'Cancelada'
          AND NOT EXISTS (SELECT 1 FROM order_hold h WHERE h.process_code = o.process_code AND h.state = 'cancelado')
          AND NOT EXISTS (SELECT 1 FROM step_state ss WHERE ss.scope = o.process_code AND ss.step_key = 'lancamento' AND ${launched})
          AND NOT (
            EXISTS (SELECT 1 FROM shipments s WHERE s.process_code = o.process_code AND s.removed_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.process_code = o.process_code AND s.removed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM step_state ss WHERE ss.scope = s.pi_number AND ss.step_key = 'lancamento' AND ${launched}))
          )))`,
    [user],
  );
  return rows.map((r) => r.process_code);
}

/** Ordem das situações do frete na planilha (on hold e desconhecido ficam de fora). */
const STAGE: Record<string, number> = { pronto: 0, booking: 1, transito: 2, desembaraco: 3, agendada: 4, entregue: 5 };

const day = (v: string | null | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Rótulo do prazo de cada etapa no calendário. */
const DUE_LABEL: Record<string, string> = {
  producao: "Fim da produção",
  alinhamento: "Alinhamento de matriz",
  fci: "FCI",
  industrializacao: "Fim da industrialização",
  lancamento: "Lançamento no site",
};

function stepState(s: StepView, date: string, today: string): AgendaEvent["state"] {
  if (s.status === "late") return "late";
  if (s.status === "risk") return "risk";
  return date < today ? "late" : "todo";
}

function unitEvents(v: OrderView, u: UnitView, today: string, orderSteps: boolean): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  const base = {
    unit: u.display,
    title: (u.title ?? v.title ?? u.description ?? v.description ?? "").slice(0, 160),
    href: `#/p/${u.display}`,
    supplier: u.supplier ?? v.supplier ?? null,
    company: u.order_kind || v.kind || null,
    watching: u.watching,
    who: null,
  };
  // Datas do frete (planilha de importação): previstas até o dia passar, depois realizadas.
  const s = u.shipment;
  if (s) {
    // Pela situação do frete na planilha: o que já passou daquele ponto está feito, mesmo sem a data preenchida;
    // a data que passou sem o frete avançar fica "data passou" (embarque sem sair, navio sem chegar, entrega sem acontecer):
    // pode ser atraso ou só a planilha sem atualizar, por isso não conta como atraso, como no restante do Freeway.
    const stage = STAGE[s.status] ?? -1;
    const delivered = day(s.delivered_at) ?? (stage >= STAGE.entregue ? day(s.delivery_forecast) : null);
    const marks: [string, string, string | null, number][] = [
      ["etd", "Embarque (ETD)", day(s.etd), STAGE.transito],
      ["eta", "Chegada ao porto (ETA)", day(s.eta), STAGE.desembaraco],
      ["duimp", "Registro da DUIMP", day(s.duimp_at), -1],
      ["sefaz", "Liberação SEFAZ", day(s.sefaz_at), -1],
      ["entrega", delivered ? "Entregue no CD" : "Previsão de entrega no CD", delivered ?? day(s.delivery_forecast), STAGE.entregue],
    ];
    for (const [key, label, date, reached] of marks) {
      if (!date) continue;
      let state: AgendaEvent["state"];
      if (key === "entrega") state = delivered ? "done" : date < today ? "risk" : "todo";
      else if (reached < 0 || stage < 0) state = date <= today ? "done" : "todo";
      else state = stage >= reached ? "done" : date < today ? "risk" : "todo";
      out.push({ ...base, id: `${u.unit}:${key}`, date, group: "logistica", track: "operacao", key, label, state, forecast: state !== "done" });
    }
  }
  // Prazos das etapas ainda abertas. As do pedido original (antes dos fretes) entram uma vez só, no pedido.
  for (const st of u.steps) {
    if (st.scope === "order" && !orderSteps) continue;
    // As etapas de desenvolvimento de um pedido com lançamento entram pelas tarefas do Monday.
    if (st.track === "desenvolvimento" && v.dev) continue;
    const date = day(st.due);
    if (!date || st.status === "done" || st.status === "na") continue;
    const ev = st.scope === "order" ? { ...base, unit: v.process_code, href: `#/p/${v.process_code}` } : base;
    out.push({ ...ev, id: `${st.scope === "order" ? v.process_code : u.unit}:${st.key}`, date, group: "prazo", track: st.track, key: st.key, label: DUE_LABEL[st.key] ?? st.label, state: stepState(st, date, today), forecast: true });
  }
  return out;
}

function taskEvents(p: DevProjectView, today: string): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  const tasks: [string, DevTask][] = [...Object.entries(p.info.tasks).flatMap(([k, list]) => list.map((t) => [k, t] as [string, DevTask])), ...p.info.other_tasks.map((t) => ["outras", t] as [string, DevTask])];
  tasks.forEach(([key, t], i) => {
    if (t.state === "na") return;
    const done = t.state === "done";
    const date = done ? day(t.done_at) ?? day(t.due) : day(t.due);
    if (!date) return;
    out.push({
      id: `dev:${p.info.item_id}:${i}`,
      date,
      group: "tarefa",
      track: "desenvolvimento",
      key,
      label: t.name,
      unit: p.info.name,
      title: [p.info.launch_group, p.info.tipo].filter(Boolean).join(" · "),
      href: `#/dev/${p.info.item_id}`,
      supplier: null,
      company: null,
      state: done ? "done" : t.state === "late" || date < today ? "late" : t.state === "blocked" ? "risk" : "todo",
      forecast: !done,
      watching: !!p.watching,
      who: t.owner,
    });
  });
  return out;
}

/** Eventos entre from e to (AAAA-MM-DD; sem datas, o mês de hoje): a tela pede um mês por vez. */
export async function agendaEvents(db: DB, user: string, from?: string | null, to?: string | null): Promise<{ events: AgendaEvent[]; today: string; from: string; to: string }> {
  const today = todayBR();
  const lo = day(from) ?? `${today.slice(0, 7)}-01`;
  const hi = day(to) ?? `${today.slice(0, 7)}-31`;
  const [views, projects] = await Promise.all([
    activeCodes(db, user).then((codes) => loadViews(db, codes, user)),
    devProjects(db).then((list) => markWatching(db, list, user)),
  ]);
  const events: AgendaEvent[] = [];
  for (const v of views) v.units.forEach((u, i) => events.push(...unitEvents(v, u, today, i === 0)));
  for (const p of projects) events.push(...taskEvents(p, today));
  // A mesma data repetida (ex.: dois fretes com o mesmo prazo do pedido) aparece uma vez só.
  const seen = new Set<string>();
  const unique = events.filter((e) => e.date >= lo && e.date <= hi && (seen.has(e.id) ? false : (seen.add(e.id), true)));
  unique.sort((a, b) => a.date.localeCompare(b.date) || a.unit.localeCompare(b.unit));
  return { events: unique, today, from: lo, to: hi };
}
