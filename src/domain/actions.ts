import type { DB } from "../env";
import { all, nowIso, one, run, todayBR } from "../db/q";
import { APPROVAL_LABEL, displayPi, fmtDate, piFromDisplay } from "../shared/labels";
import { insertEvents, unitLabel, type NewEvent } from "./events";
import { notifyForEvents, runTimeRules } from "./rules";
import { STEP_BY_KEY } from "./steps";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Campos que cada etapa aceita do usuário. O resto é ignorado.
const MANUAL_FIELDS = ["started_at", "due", "link", "done_at", "note", "na"];
const FIELDS: Record<string, string[]> = {
  amostra: ["tracking", "carrier", "destination", "delivered_at", "approval", "approval_note", "na"],
  producao: ["start", "due", "done_at", "note", "docs_done_at", "docs_link"],
  alinhamento: ["enabled", "carrier", "tracking", "delivered_at", "done_at", "note"],
  fci: ["number", "link", "done_at", "note", "na"],
  filmagem: ["delivered_at", "due", "link", "done_at", "note", "na"],
  estampas: ["decision", "due", "link", "done_at", "note", "na"],
  marketing: ["due", "link", "done_at", "note", "na"],
  // auto_at: o Freeway marcou sozinho (fábrica). Reaberto à mão depois disso, não marca de novo.
  lancamento: ["due", "done_at", "note", "auto_at"],
  sefaz: ["manual_at"],
  industrializacao: ["done_at"],
};
// Só fazem sentido num embarque (dados da importação).
const SHIPMENT_ONLY = new Set(["sefaz", "industrializacao"]);

const DATE_FIELDS = new Set(["started_at", "due", "done_at", "start", "delivered_at", "manual_at", "docs_done_at", "auto_at"]);

function clean(field: string, v: unknown): unknown {
  if (v === "" || v === undefined) return null;
  if (DATE_FIELDS.has(field) && v !== null) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Data inválida em ${field}`);
  }
  if (typeof v === "string") return v.trim().slice(0, 2000);
  if (typeof v === "boolean" || v === null) return v;
  throw new HttpError(400, `Valor inválido em ${field}`);
}

async function readState(db: DB, scope: string, stepKey: string): Promise<Record<string, any>> {
  const row = await one<{ data: string }>(db, `SELECT data FROM step_state WHERE scope = ? AND step_key = ?`, [scope, stepKey]);
  return row ? JSON.parse(row.data) : {};
}

async function writeState(db: DB, scope: string, stepKey: string, data: Record<string, any>, user: string): Promise<void> {
  await run(
    db,
    `INSERT INTO step_state (scope, step_key, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, step_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [scope, stepKey, JSON.stringify(data), nowIso(), user],
  );
}

async function finish(db: DB, code: string, events: NewEvent[]): Promise<void> {
  await insertEvents(db, events);
  await notifyForEvents(db, events);
  await runTimeRules(db, [code]);
}

export async function requireOrder(db: DB, code: string): Promise<Record<string, any>> {
  const o = await one(db, `SELECT * FROM orders WHERE process_code = ?`, [code]);
  if (!o) throw new HttpError(404, `Processo ${code} não encontrado`);
  return o;
}

/**
 * Aceita "BBI25205", "BBI25205.2" ou "BBI25205-2". Com um frete só, o código do
 * pedido já aponta para esse frete.
 */
export async function resolveUnit(db: DB, unit: string): Promise<{ code: string; pi: string | null; freights: number }> {
  const id = piFromDisplay(unit.trim().toUpperCase());
  const m = id.match(/^((?:GOC|BBI)\d{5})(?:-\d+)?$/);
  if (!m) throw new HttpError(400, `Código inválido: ${unit}`);
  await requireOrder(db, m[1]);
  const pis = await all<{ pi_number: string }>(db, `SELECT pi_number FROM shipments WHERE process_code = ? AND removed_at IS NULL`, [m[1]]);
  if (id === m[1]) return { code: m[1], pi: pis.length === 1 ? pis[0].pi_number : null, freights: pis.length };
  if (!pis.some((p) => p.pi_number === id)) throw new HttpError(404, `Frete ${displayPi(id)} não encontrado`);
  return { code: m[1], pi: id, freights: pis.length };
}

/**
 * Atualiza uma etapa. Etapas do pedido original (amostra, produção,
 * alinhamento) sempre gravam no pedido. As demais gravam no frete indicado;
 * gravadas no pedido, valem para os fretes que ainda não têm valor próprio.
 */
export async function updateStep(db: DB, unit: string, stepKey: string, patch: Record<string, unknown>, user: string): Promise<void> {
  const { code, pi: piIn, freights } = await resolveUnit(db, unit);
  const def = STEP_BY_KEY[stepKey];
  if (!def) throw new HttpError(400, `Etapa inválida: ${stepKey}`);
  const pi = def.scope === "unit" ? piIn : null;
  if (SHIPMENT_ONLY.has(stepKey) && !pi) throw new HttpError(400, `${def.label} é marcada em cada frete`);
  const scope = pi ?? code;
  const label = unitLabel(code, pi, freights);
  const allowed = FIELDS[stepKey] ?? MANUAL_FIELDS;
  const old = await readState(db, scope, stepKey);
  const next: Record<string, any> = { ...old };
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    next[k] = clean(k, v);
  }
  const today = todayBR();
  const changed = (k: string) => (old[k] ?? null) !== (next[k] ?? null);
  const events: NewEvent[] = [];
  const ev = (type: string, message: string, extra: Partial<NewEvent> = {}) =>
    events.push({ process_code: code, pi_number: pi, step_key: stepKey, type, message, actor: user, unit_label: label, ...extra });
  const forAll = def.scope === "unit" && !pi && freights > 1 ? " (vale para todos os fretes)" : "";

  if (changed("na")) ev("etapa_na", next.na ? `${label}: ${def.label} marcada como não se aplica${forAll}` : `${label}: ${def.label} voltou a valer`);
  if (changed("done_at")) {
    if (next.done_at) next.done_by = user;
    if (next.done_at && stepKey === "mockups") ev("mockups_concluidos", `${label}: mockups concluídos${forAll}`);
    else if (next.done_at && stepKey === "lancamento") ev("lancado", `${label}: lançado no site em ${fmtDate(next.done_at)}${forAll}`, { new_value: next.done_at });
    else if (next.done_at && stepKey === "industrializacao") ev("industrializacao_concluida", `${label}: industrialização concluída`);
    else if (next.done_at && stepKey === "filmagem") {
      // Com o link dos vídeos no mesmo salvamento, o aviso de vídeos prontos já basta.
      if (!(changed("link") && next.link)) ev("filmagem_concluida", `${label}: filmagem concluída${forAll}`);
    } else if (next.done_at) ev("etapa_concluida", `${label}: ${def.label} concluída${forAll}`);
    else ev("etapa_reaberta", `${label}: ${def.label} reaberta`);
  }
  if (changed("due") && next.due) {
    if (stepKey === "filmagem") ev("filmagem_prazo", `Prazo da filmagem: ${fmtDate(next.due)}`, { new_value: next.due });
    else if (stepKey === "lancamento") ev("lancamento_data", `${label}: lançamento previsto para ${fmtDate(next.due)}${forAll}`, { new_value: next.due });
    else ev("prazo", `${label}: ${def.label}, prazo ${fmtDate(next.due)}`, { new_value: next.due });
  }
  if (changed("start") && next.start) ev("inicio", `${def.label}: início ${fmtDate(next.start)}`);
  if (changed("note") && next.note) ev("observacao", `${label}: ${def.label}: ${next.note}`);

  switch (stepKey) {
    case "producao":
      if (changed("docs_done_at")) {
        next.docs_by = next.docs_done_at ? user : null;
        if (next.docs_done_at) ev("documentacao_pronta", "Documentação do pedido pronta (carton marks, barcodes)", { link: next.docs_link ?? undefined });
        else ev("documentacao_reaberta", "Documentação do pedido desmarcada");
      }
      break;
    case "amostra":
    case "alinhamento":
      if (changed("tracking")) {
        delete next.fedex;
        if (next.tracking) ev("rastreio", `${def.label}: rastreio ${next.tracking}`, { new_value: next.tracking });
      }
      if (changed("delivered_at") && next.delivered_at) {
        ev(stepKey === "amostra" ? "amostra_entregue" : "alinhamento_entregue",
          stepKey === "amostra" ? `Amostra entregue em ${next.destination || "Fortaleza"}` : `20 amostras de alinhamento entregues em Extrema em ${fmtDate(next.delivered_at)}`);
      }
      if (stepKey === "alinhamento" && changed("enabled")) ev("alinhamento", next.enabled ? "Alinhamento de matriz ligado" : "Alinhamento de matriz desligado");
      if (stepKey === "amostra" && changed("approval")) {
        next.approval_by = next.approval ? user : null;
        next.approval_at = next.approval ? today : null;
        if (next.approval === "reprovado") ev("amostra_reprovada", `Amostra reprovada${next.approval_note ? `: ${next.approval_note}` : ""}`);
        else if (next.approval) ev("amostra_aprovada", `Amostra ${APPROVAL_LABEL[next.approval].toLowerCase()}${next.approval_note ? `: ${next.approval_note}` : ""}`);
      }
      break;
    case "filmagem":
      if (changed("delivered_at") && next.delivered_at) ev("filmagem_entregue", `Amostras entregues ao time de filmagem em ${fmtDate(next.delivered_at)}`);
      if (changed("link") && next.link) ev("videos_prontos", "Vídeos prontos", { link: next.link, new_value: next.link });
      break;
    case "estampas":
      if (changed("decision") && next.decision) {
        ev("estampas_decisao", next.decision === "nao_precisa" ? "Ilustração: não precisa de estampas novas" : "Ilustração vai criar/adaptar estampas", { new_value: next.decision });
      }
      break;
    case "sefaz":
      if (!old.manual_at && next.manual_at) ev("sefaz_liberada", `${label}: desembaraço concluído (marcado no app)`);
      break;
  }

  await writeState(db, scope, stepKey, next, user);
  await finish(db, code, events);
}

export const TITLE_MAX = 120;

/**
 * Título dado no app. Num pedido dividido, o título de um frete vale só para ele;
 * dado no pedido (ou com um frete só), vale para o pedido todo. Vazio volta ao da planilha.
 */
export async function setUnitTitle(db: DB, unit: string, raw: unknown, user: string): Promise<string | null> {
  const { code, pi, freights } = await resolveUnit(db, unit);
  const key = pi && freights > 1 ? pi : code;
  const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
  const old = await one<{ title: string }>(db, `SELECT title FROM unit_titles WHERE unit = ?`, [key]);
  if ((old?.title ?? "") === title) return title || null;
  if (title) {
    await run(
      db,
      `INSERT INTO unit_titles (unit, process_code, title, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(unit) DO UPDATE SET title = excluded.title, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [key, code, title, user, nowIso()],
    );
  } else {
    await run(db, `DELETE FROM unit_titles WHERE unit = ?`, [key]);
  }
  const label = unitLabel(code, key === code ? null : key, freights);
  await insertEvents(db, [{
    process_code: code, pi_number: key === code ? null : key, type: "titulo", actor: user,
    message: title ? `${label}: título alterado para "${title}"` : `${label}: título voltou ao da planilha`,
    old_value: old?.title ?? null, new_value: title || null,
  }]);
  return title || null;
}

/** Ações de um clique que aparecem nos próximos passos, no pedido ou frete indicado. */
export async function runAction(db: DB, unit: string, action: string, user: string): Promise<void> {
  const { code, pi, freights } = await resolveUnit(db, unit);
  const today = todayBR();
  if (action === "notify_ilustracao") {
    const scope = pi ?? code;
    // Parte do que já foi herdado do pedido, para não perder a decisão anterior.
    const d = { ...(await readState(db, code, "estampas")), ...(pi ? await readState(db, pi, "estampas") : {}) };
    if (d.notified_at) return;
    d.notified_at = today;
    d.notified_by = user;
    await writeState(db, scope, "estampas", d, user);
    const label = unitLabel(code, pi, freights);
    await finish(db, code, [{ process_code: code, pi_number: pi, step_key: "estampas", type: "ilustracao_avisada", message: `${label}: time de ilustração avisado`, actor: user, unit_label: label }]);
    return;
  }
  if (action === "filmagem_entregue") {
    await updateStep(db, pi ?? code, "filmagem", { delivered_at: today }, user);
    return;
  }
  if (action === "docs_prontos") {
    await updateStep(db, code, "producao", { docs_done_at: today }, user);
    return;
  }
  throw new HttpError(400, `Ação desconhecida: ${action}`);
}

const MARK_KINDS: Record<string, { label: string; step: string }> = {
  cadastro: { label: "cadastro no site", step: "cadastro_site" },
  fci: { label: "com FCI", step: "fci" },
  wms: { label: "cadastro no WMS", step: "cadastro_wms" },
  lancado: { label: "lançado no site", step: "lancamento" },
};

/**
 * Marca (ou desmarca) um item do pedido ou do frete em cadastro, WMS ou
 * lançamento. Com todos os itens marcados, a etapa do frete fica concluída.
 */
export async function setItemMark(db: DB, itemId: string, kind: string, done: boolean, user: string): Promise<void> {
  const k = MARK_KINDS[kind];
  if (!k) throw new HttpError(400, `Frente inválida: ${kind}`);
  const ship = await one(db, `SELECT id, pi_number, process_code, sku, item_supplier FROM shipment_items WHERE id = ?`, [itemId]);
  let item = ship ?? (await one(db, `SELECT id, NULL AS pi_number, process_code, sku, item_supplier FROM order_items WHERE id = ?`, [itemId]));
  // Item da lista de SKUs (antes dos itens da planilha): o pedido vem da lista ou do lançamento ligado a ela.
  const fromList = !item && /^sku:\d+$/.test(itemId);
  if (fromList) {
    const r = await one<{ scope: string; code: string | null; name: string | null }>(db, `SELECT scope, code, name FROM sku_lists WHERE id = ?`, [Number(itemId.slice(4))]);
    let code = r?.scope ?? null;
    if (code?.startsWith("dev:")) {
      const it = await one<{ process_codes: string }>(db, `SELECT process_codes FROM monday_items WHERE item_id = ?`, [code.slice(4)]);
      code = it ? (JSON.parse(it.process_codes ?? "[]")[0] ?? null) : null;
    }
    if (r && code) item = { id: itemId, pi_number: null, process_code: code, sku: r.name ?? r.code, item_supplier: null };
  }
  if (!item) throw new HttpError(404, "Item não encontrado");
  if (done) await run(db, `INSERT INTO item_marks (item_id, kind, done_at, done_by) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, kind) DO NOTHING`, [itemId, kind, todayBR(), user]);
  else await run(db, `DELETE FROM item_marks WHERE item_id = ? AND kind = ?`, [itemId, kind]);
  const unit = item.pi_number ?? item.process_code;
  const { freights } = await resolveUnit(db, unit);
  const label = unitLabel(item.process_code, item.pi_number, freights);
  await insertEvents(db, [{
    process_code: item.process_code, pi_number: item.pi_number, step_key: k.step, type: "item_marcado", actor: user, unit_label: label,
    message: `${label}: ${item.sku ?? item.item_supplier ?? "item"} ${done ? "" : "des"}marcado como ${k.label}`,
  }]);
  // A lista de SKUs muda até a PO chegar: marcar todos não conclui a etapa sozinho.
  if (!done || fromList) return;
  const pending = await one<{ n: number }>(
    db,
    ship
      ? `SELECT COUNT(*) AS n FROM shipment_items i LEFT JOIN item_marks m ON m.item_id = i.id AND m.kind = ? WHERE i.pi_number = ? AND i.removed_at IS NULL AND m.item_id IS NULL`
      : `SELECT COUNT(*) AS n FROM order_items i LEFT JOIN item_marks m ON m.item_id = i.id AND m.kind = ? WHERE i.process_code = ? AND i.removed_at IS NULL AND m.item_id IS NULL`,
    [kind, unit],
  );
  const state = await readState(db, unit, k.step);
  if (!pending?.n && !state.done_at) await updateStep(db, unit, k.step, { done_at: todayBR() }, user);
}

export async function setItemCheck(db: DB, itemId: string, done: boolean, user: string): Promise<void> {
  const item = await one(db, `SELECT id, pi_number, process_code, item_supplier, sku FROM shipment_items WHERE id = ?`, [itemId]);
  if (!item) throw new HttpError(404, "Item não encontrado");
  if (done) {
    await run(db, `INSERT INTO item_checks (shipment_item_id, done_at, done_by) VALUES (?, ?, ?) ON CONFLICT(shipment_item_id) DO NOTHING`, [itemId, todayBR(), user]);
  } else {
    await run(db, `DELETE FROM item_checks WHERE shipment_item_id = ?`, [itemId]);
  }
  const { freights } = await resolveUnit(db, item.pi_number);
  const label = unitLabel(item.process_code, item.pi_number, freights);
  const events: NewEvent[] = [
    {
      process_code: item.process_code, pi_number: item.pi_number, step_key: "industrializacao", type: "item_industrializado",
      message: `${label}: ${item.sku ?? item.item_supplier ?? "item"} ${done ? "industrializado" : "desmarcado"}`, actor: user, unit_label: label,
    },
  ];
  if (done) {
    const pending = await all(
      db,
      `SELECT i.id FROM shipment_items i LEFT JOIN item_checks c ON c.shipment_item_id = i.id
        WHERE i.pi_number = ? AND i.removed_at IS NULL AND c.shipment_item_id IS NULL`,
      [item.pi_number],
    );
    if (!pending.length) {
      events.push({ process_code: item.process_code, pi_number: item.pi_number, step_key: "industrializacao", type: "industrializacao_concluida", message: `${label}: industrialização concluída`, actor: user, unit_label: label });
    }
  }
  await finish(db, item.process_code, events);
}
