import type { DB } from "../env";
import { all, nowIso, one, run, todayBR, upsertJson } from "../db/q";
import { fmtDate, PRODUCTION_STATUS_LABEL, SHIPMENT_STATUS_LABEL } from "../shared/labels";
import { insertEvents, unitLabel, type NewEvent } from "../domain/events";
import { notifyForEvents } from "../domain/rules";
import { normalize, type Issue } from "./normalize";
import type { Grid } from "./xlsx";

/** Hash rápido e estável (cyrb53) só para detectar mudança de linha. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface SyncResult {
  ok: boolean;
  skipped?: boolean;
  baseline: boolean;
  counts: Record<string, number>;
  changed: Record<string, number>;
  removed: Record<string, number>;
  events: number;
  notifications: number;
  issues: Issue[];
}

const ORDER_COLS = [
  "process_code", "kind", "description", "area", "category", "buyer", "supplier", "po_status",
  "production_status", "production_status_raw", "po_date", "prod_start_sheet", "prod_end_sheet",
  "leadtime", "qty_total", "sku_count", "pending_delivery", "files_url", "notes",
];
const SHIPMENT_COLS = [
  "pi_number", "process_code", "seq", "status", "status_raw", "destination", "modal", "trader",
  "carrier_line", "ref_bl", "qty", "etd", "eta", "duimp_at", "draft_duimp", "canal", "sefaz_at",
  "nf", "nf_date", "delivery_forecast", "notes",
];
const ORDER_ITEM_COLS = ["id", "process_code", "item_supplier", "sku", "sku_key", "sku_code", "line", "qty", "shipped_qty", "pending_qty"];
const SHIPMENT_ITEM_COLS = ["id", "pi_number", "process_code", "item_supplier", "sku", "sku_key", "sku_code", "qty", "boxes"];

function withHash<T extends object>(rec: T, cols: string[]): T & { row_hash: string } {
  const r = rec as Record<string, unknown>;
  return { ...rec, row_hash: hash(JSON.stringify(cols.map((c) => r[c] ?? null))) };
}

async function existingHashes(db: DB, table: string, keyCol: string, extra = ""): Promise<Map<string, string>> {
  const rows = await all<{ k: string; h: string }>(
    db,
    `SELECT ${keyCol} AS k, row_hash AS h FROM ${table} WHERE removed_at IS NULL ${extra}`,
  );
  return new Map(rows.map((r) => [r.k, r.h]));
}

async function markRemoved(db: DB, table: string, keyCol: string, keep: string[], extra = ""): Promise<number> {
  return run(
    db,
    `UPDATE ${table} SET removed_at = ? WHERE removed_at IS NULL ${extra}
       AND ${keyCol} NOT IN (SELECT value FROM json_each(?))`,
    [nowIso(), JSON.stringify(keep)],
  );
}

/**
 * Aplica um retrato completo da planilha ao banco: grava só as linhas que
 * mudaram e transforma as mudanças relevantes em eventos (e notificações).
 * Na primeira carga não gera eventos: ela é a linha de base.
 */
export async function ingestSheet(db: DB, tabs: Record<string, Grid>, source: string): Promise<SyncResult> {
  const norm = normalize(tabs);
  const result: SyncResult = {
    ok: true,
    baseline: false,
    counts: {
      processos: norm.orders.length,
      embarques: norm.shipments.length,
      itens: norm.orderItems.length,
      itens_embarque: norm.shipmentItems.length,
    },
    changed: {},
    removed: {},
    events: 0,
    notifications: 0,
    issues: norm.issues,
  };

  if (norm.orders.length === 0) {
    result.ok = false;
    result.issues.unshift({ tab: "Controle POs", row: 0, message: "Nenhum processo lido; nada foi alterado" });
    await logSync(db, source, result);
    return result;
  }

  const orders = norm.orders.map((o) => withHash(o, ORDER_COLS));
  const shipments = norm.shipments.map((s) => withHash(s, SHIPMENT_COLS));
  const orderItems = norm.orderItems.map((i) => withHash(i, ORDER_ITEM_COLS));
  const shipmentItems = norm.shipmentItems.map((i) => withHash(i, SHIPMENT_ITEM_COLS));

  const fullHash = hash([orders, shipments, orderItems, shipmentItems].map((l) => l.map((r) => r.row_hash).join(",")).join("|"));
  const last = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'sheet_hash'`);
  if (last?.value === fullHash) {
    result.skipped = true;
    await logSync(db, source, result);
    return result;
  }

  const now = nowIso();
  const today = todayBR();
  const events: NewEvent[] = [];

  // Processos
  const oldOrderHashes = await existingHashes(db, "orders", "process_code", "AND source = 'sheet'");
  const baseline = oldOrderHashes.size === 0;
  result.baseline = baseline;
  const changedOrders = orders.filter((o) => oldOrderHashes.get(o.process_code) !== o.row_hash);
  if (!baseline && changedOrders.length) {
    const prev = await all(
      db,
      `SELECT process_code, production_status, po_status FROM orders
        WHERE process_code IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(changedOrders.map((o) => o.process_code))],
    );
    const byCode = new Map(prev.map((p) => [p.process_code as string, p]));
    for (const o of changedOrders) {
      const p = byCode.get(o.process_code);
      if (!p) continue;
      if (p.production_status !== o.production_status && o.production_status) {
        events.push({
          process_code: o.process_code,
          step_key: "producao",
          type: "producao_status",
          message: `Produção: ${PRODUCTION_STATUS_LABEL[p.production_status] ?? "sem status"} → ${PRODUCTION_STATUS_LABEL[o.production_status]}`,
          old_value: p.production_status,
          new_value: o.production_status,
          actor: "planilha",
        });
      }
      if (p.po_status !== o.po_status && o.po_status) {
        events.push({
          process_code: o.process_code,
          type: "po_status",
          message: `Processo marcado como ${o.po_status} na planilha`,
          old_value: p.po_status,
          new_value: o.po_status,
          actor: "planilha",
        });
      }
    }
  }
  await upsertJson(
    db,
    "orders",
    [...ORDER_COLS, "source", "row_hash", "removed_at", "updated_at"],
    ["process_code"],
    changedOrders.map((o) => ({ ...o, source: "sheet", removed_at: null, updated_at: now })),
  );
  result.changed.processos = changedOrders.length;
  result.removed.processos = await markRemoved(
    db, "orders", "process_code", orders.map((o) => o.process_code), "AND source = 'sheet'",
  );

  // Embarques
  const oldShipHashes = await existingHashes(db, "shipments", "pi_number");
  const shipBaseline = oldShipHashes.size === 0;
  const changedShips = shipments.filter((s) => oldShipHashes.get(s.pi_number) !== s.row_hash);
  const delivered: string[] = [];
  if (!shipBaseline && changedShips.length) {
    const prev = await all(
      db,
      `SELECT pi_number, status, eta, etd, sefaz_at, canal, duimp_at FROM shipments
        WHERE pi_number IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(changedShips.map((s) => s.pi_number))],
    );
    const byPi = new Map(prev.map((p) => [p.pi_number as string, p]));
    const freights = new Map<string, number>();
    for (const s of shipments) freights.set(s.process_code, (freights.get(s.process_code) ?? 0) + 1);
    for (const s of changedShips) {
      const label = unitLabel(s.process_code, s.pi_number, freights.get(s.process_code) ?? 1);
      const base = { process_code: s.process_code, pi_number: s.pi_number, actor: "planilha", unit_label: label };
      const p = byPi.get(s.pi_number);
      if (!p) {
        const split = (freights.get(s.process_code) ?? 1) > 1;
        events.push({
          ...base, step_key: "importacao", type: "novo_embarque", new_value: s.status,
          message: split ? `Novo frete ${label}: o pedido foi dividido e ${label} passa a ser acompanhado como um pedido próprio` : `${label}: embarque registrado na planilha`,
        });
        continue;
      }
      if (p.status !== s.status) {
        events.push({
          ...base,
          step_key: s.status === "entregue" || s.status === "agendada" ? "chegada" : s.status === "desembaraco" ? "sefaz" : "importacao",
          type: "embarque_status",
          message: `${label}: ${SHIPMENT_STATUS_LABEL[p.status] ?? p.status} → ${SHIPMENT_STATUS_LABEL[s.status] ?? s.status}`,
          old_value: p.status,
          new_value: s.status,
        });
        if (s.status === "entregue") delivered.push(s.pi_number);
      }
      if (p.eta && s.eta && p.eta !== s.eta) {
        events.push({ ...base, step_key: "importacao", type: "eta_mudou", message: `${label}: ETA Santos mudou de ${fmtDate(p.eta)} para ${fmtDate(s.eta)}`, old_value: p.eta, new_value: s.eta });
      }
      if (p.etd && s.etd && p.etd !== s.etd) {
        events.push({ ...base, step_key: "importacao", type: "etd_mudou", message: `${label}: ETD mudou de ${fmtDate(p.etd)} para ${fmtDate(s.etd)}`, old_value: p.etd, new_value: s.etd });
      }
      if (!p.duimp_at && s.duimp_at) {
        events.push({ ...base, step_key: "sefaz", type: "duimp_registrada", message: `${label}: DI/DUIMP registrada em ${fmtDate(s.duimp_at)}`, new_value: s.duimp_at });
      }
      if (p.canal !== s.canal && s.canal) {
        events.push({ ...base, step_key: "sefaz", type: "canal", message: `${label}: canal ${s.canal}`, old_value: p.canal, new_value: s.canal });
      }
      if (!p.sefaz_at && s.sefaz_at) {
        events.push({ ...base, step_key: "sefaz", type: "sefaz_liberada", message: `${label}: desembaraço concluído (SEFAZ liberada em ${fmtDate(s.sefaz_at)})`, new_value: s.sefaz_at });
      }
    }
  }
  await upsertJson(
    db,
    "shipments",
    [...SHIPMENT_COLS, "row_hash", "removed_at", "updated_at"],
    ["pi_number"],
    changedShips.map((s) => ({ ...s, removed_at: null, updated_at: now })),
  );
  if (delivered.length) {
    await run(
      db,
      `UPDATE shipments SET delivered_at = ? WHERE delivered_at IS NULL AND pi_number IN (SELECT value FROM json_each(?))`,
      [today, JSON.stringify(delivered)],
    );
  }
  result.changed.embarques = changedShips.length;
  result.removed.embarques = await markRemoved(db, "shipments", "pi_number", shipments.map((s) => s.pi_number));

  // Itens do pedido e itens de cada embarque: sem eventos, só espelho.
  for (const [table, cols, rows, label] of [
    ["order_items", ORDER_ITEM_COLS, orderItems, "itens"],
    ["shipment_items", SHIPMENT_ITEM_COLS, shipmentItems, "itens_embarque"],
  ] as const) {
    const old = await existingHashes(db, table, "id");
    const changed = (rows as { id: string; row_hash: string }[]).filter((r) => old.get(r.id) !== r.row_hash);
    await upsertJson(db, table, [...cols, "row_hash", "removed_at"], ["id"], changed.map((r) => ({ ...r, removed_at: null })));
    result.changed[label] = changed.length;
    result.removed[label] = await markRemoved(db, table, "id", rows.map((r) => r.id));
  }

  await insertEvents(db, events);
  result.events = events.length;
  result.notifications = await notifyForEvents(db, events);

  await run(db, `INSERT INTO settings (key, value) VALUES ('sheet_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [fullHash]);
  await logSync(db, source, result);
  return result;
}

async function logSync(db: DB, source: string, r: SyncResult): Promise<void> {
  const { issues, ...summary } = r;
  await run(db, `INSERT INTO sheet_syncs (source, ran_at, ok, summary, issues) VALUES (?, ?, ?, ?, ?)`, [
    source,
    nowIso(),
    r.ok ? 1 : 0,
    JSON.stringify(summary),
    JSON.stringify(issues.slice(0, 300)),
  ]);
  // Mantém só o histórico recente.
  await run(db, `DELETE FROM sheet_syncs WHERE id NOT IN (SELECT id FROM sheet_syncs ORDER BY id DESC LIMIT 200)`);
}
