import type { DB, Env } from "../env";
import { all, nowIso, run, todayBR, upsertJson } from "../db/q";
import { addDays } from "../shared/labels";
import { gdiOrdens, itapevaConfigured } from "../integrations/itapeva";
import { hash } from "../sheet/sync";
import { setItemCheck } from "./actions";

// Janela de OPs lidas a cada rodada (pela data de criação).
const WINDOW_DAYS = 400;
// A OP pode ser aberta uns dias antes de o frete constar como entregue na planilha.
const TOLERANCE_DAYS = 3;
const ACTOR = "GDI (Itapeva)";

const pick = (r: Record<string, any>, ...keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") return String(r[k]);
  return null;
};
const brDate = (iso: string) => new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Industrialização de Itapeva: espelha as OPs do GDI (só OP e OPI, chave = id)
 * e liga cada uma aos itens dos fretes BBI entregues.
 */
export async function refreshItapeva(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!itapevaConfigured(env)) return { skipped: "ITAPEVA_API_KEY não configurada" };
  const desde = addDays(todayBR(), -WINDOW_DAYS);
  const rows = await gdiOrdens(env, { tipo: "OP,OPI", desde, campo: "criado_em", limite: "50000" });
  const prev = new Map((await all<{ id: string; row_hash: string }>(db, `SELECT id, row_hash FROM gdi_ordens`)).map((r) => [r.id, r.row_hash]));
  const changed: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r.id) continue;
    const row = {
      id: String(r.id),
      numero: pick(r, "op_numero", "numero"),
      prefixo: pick(r, "prefixo"),
      tipo: pick(r, "tipo"),
      item: pick(r, "item_codigo", "item"),
      pedido: pick(r, "num_pedido"),
      status: pick(r, "status"),
      quantidade: Number(r.quantidade) || 0,
      criado_em: pick(r, "criado_em"),
      concluido_em: pick(r, "concluido_em"),
      data: JSON.stringify(r),
    };
    const h = hash(JSON.stringify(row));
    if (prev.get(row.id) !== h) changed.push({ ...row, row_hash: h });
  }
  await upsertJson(db, "gdi_ordens", ["id", "numero", "prefixo", "tipo", "item", "pedido", "status", "quantidade", "criado_em", "concluido_em", "data", "row_hash"], ["id"], changed);
  const alloc = await allocate(db);
  console.log(`[itapeva] ${rows.length} OPs desde ${desde} · gravadas ${changed.length} · ${JSON.stringify(alloc)}`);
  return { ordens: rows.length, gravadas: changed.length, ...alloc };
}

interface Op {
  id: string;
  numero: string | null;
  item: string;
  status: string;
  quantidade: number;
  criado_em: string;
  concluido_em: string | null;
}

/**
 * Liga as OPs aos itens dos fretes BBI entregues. A OP não cita o BBI: a
 * ligação é pelo SKU (item_codigo = SKU + "BR") e pela ordem de chegada —
 * cada OP abate primeiro do frete que chegou antes (FIFO), a partir da sua
 * chegada. Item com tudo concluído é marcado como industrializado, uma vez
 * só: se alguém desmarcar à mão, o Freeway respeita.
 */
export async function allocate(db: DB): Promise<Record<string, number>> {
  const ops = await all<Op>(
    db,
    `SELECT id, numero, item, status, quantidade, criado_em, concluido_em FROM gdi_ordens
      WHERE COALESCE(status, '') <> 'cancelado' AND item IS NOT NULL AND quantidade > 0 AND criado_em IS NOT NULL
      ORDER BY criado_em`,
  );
  if (!ops.length) return { itens: 0 };
  // Fretes que chegaram antes do GDI existir foram industrializados fora dele.
  const gdiStart = addDays(brDate(ops[0].criado_em), -TOLERANCE_DAYS);
  const items = await all<{ id: string; sku_code: string; qty: number; arrived: string; pi_number: string }>(
    db,
    `SELECT i.id, i.sku_code, i.qty, COALESCE(s.delivered_at, s.delivery_forecast) AS arrived, i.pi_number
       FROM shipment_items i
       JOIN shipments s ON s.pi_number = i.pi_number AND s.removed_at IS NULL
       JOIN orders o ON o.process_code = i.process_code
      WHERE i.removed_at IS NULL AND o.kind = 'BBI' AND s.status = 'entregue' AND i.sku_code IS NOT NULL AND i.qty > 0
        AND COALESCE(s.delivered_at, s.delivery_forecast) >= ?
      ORDER BY arrived, i.pi_number`,
    [gdiStart],
  );
  const bySku = new Map<string, typeof items>();
  for (const it of items) bySku.set(it.sku_code, [...(bySku.get(it.sku_code) ?? []), it]);

  const acc = new Map<string, { done: number; doing: number; ops: string[]; last: string | null }>();
  const left = new Map(items.map((it) => [it.id, it.qty]));
  for (const op of ops) {
    const list = bySku.get(op.item.replace(/BR$/i, ""));
    if (!list) continue;
    const created = brDate(op.criado_em);
    let q = op.quantidade;
    for (const it of list) {
      if (q <= 0 || addDays(it.arrived, -TOLERANCE_DAYS) > created) break;
      const r = left.get(it.id)!;
      if (r <= 0) continue;
      const take = Math.min(r, q);
      left.set(it.id, r - take);
      q -= take;
      const a = acc.get(it.id) ?? { done: 0, doing: 0, ops: [], last: null };
      if (op.status === "concluido") {
        a.done += take;
        if (op.concluido_em && (!a.last || op.concluido_em > a.last)) a.last = op.concluido_em;
      } else a.doing += take;
      a.ops.push(`${op.numero ?? op.id} (${op.status})`);
      acc.set(it.id, a);
    }
  }

  const prev = new Map((await all<{ shipment_item_id: string; row_hash: string; auto_checked_at: string | null }>(db, `SELECT shipment_item_id, row_hash, auto_checked_at FROM gdi_alloc`)).map((r) => [r.shipment_item_id, r]));
  const rows: Record<string, unknown>[] = [];
  for (const [id, a] of acc) {
    const row = { shipment_item_id: id, done_qty: a.done, doing_qty: a.doing, ops: JSON.stringify(a.ops.slice(-20)), last_done_at: a.last ? brDate(a.last) : null };
    const h = hash(JSON.stringify(row));
    if (prev.get(id)?.row_hash !== h) rows.push({ ...row, auto_checked_at: prev.get(id)?.auto_checked_at ?? null, row_hash: h });
  }
  await upsertJson(db, "gdi_alloc", ["shipment_item_id", "done_qty", "doing_qty", "ops", "last_done_at", "auto_checked_at", "row_hash"], ["shipment_item_id"], rows);
  await run(db, `DELETE FROM gdi_alloc WHERE shipment_item_id NOT IN (SELECT value FROM json_each(?))`, [JSON.stringify([...acc.keys()])]);

  // Item todo concluído no GDI: marca como industrializado (só na primeira vez).
  const toCheck = await all<{ id: string }>(
    db,
    `SELECT a.shipment_item_id AS id FROM gdi_alloc a JOIN shipment_items i ON i.id = a.shipment_item_id
      LEFT JOIN item_checks c ON c.shipment_item_id = a.shipment_item_id
      WHERE a.auto_checked_at IS NULL AND c.shipment_item_id IS NULL AND a.done_qty >= i.qty
      LIMIT 40`,
  );
  for (const t of toCheck) {
    await setItemCheck(db, t.id, true, ACTOR);
    await run(db, `UPDATE gdi_alloc SET auto_checked_at = ? WHERE shipment_item_id = ?`, [nowIso(), t.id]);
  }
  const qtyOf = new Map(items.map((i) => [i.id, i.qty]));
  const done = [...acc.entries()].filter(([id, a]) => a.done >= (qtyOf.get(id) ?? Infinity)).length;
  return { itens_de_frete: items.length, com_op: acc.size, concluidos: done, marcados_agora: toCheck.length };
}
