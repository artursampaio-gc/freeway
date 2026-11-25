import type { DB, Env } from "../env";
import { all, nowIso, one, run, upsertJson } from "../db/q";
import { boardColumns, boardItems, boardItemStamps, findCodes, itemsByIds, listBoards, mondayConfigured, type MondayBoard, type MondayColumn, type MondayItem } from "../integrations/monday";
import { hash } from "../sheet/sync";
import { linkSamples } from "./samples";

// Quadro de amostras recebidas em Extrema: o rastreio FedEx vem no nome, com uma foto anexada.
const WAREHOUSE_SAMPLES = "6758443649";

// A lista de quadros muda pouco: relê no máximo uma vez por dia (ou quando pedirem).
const LIST_TTL_MS = 24 * 3600 * 1000;
// Itens: leitura completa uma vez por dia; nas outras rodadas, só os alterados.
const FULL_EVERY_MS = 24 * 3600 * 1000;
// Amostras consideradas na ligação com os pedidos.
const SAMPLE_DAYS = 90;

async function getSetting<T>(db: DB, key: string): Promise<T | null> {
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, [key]);
  return row ? (JSON.parse(row.value) as T) : null;
}

async function setSetting(db: DB, key: string, value: unknown): Promise<void> {
  await run(db, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(value)]);
}

export interface SelectedBoard {
  id: string;
  name: string;
}

export async function selectedBoards(db: DB): Promise<SelectedBoard[]> {
  return (await getSetting<SelectedBoard[]>(db, "monday_boards")) ?? [];
}

/** Quadros que o token enxerga, guardados em settings para não reler o Monday a cada abertura. */
export async function boardList(db: DB, env: Env, refresh = false): Promise<{ boards: MondayBoard[]; listed_at: string | null }> {
  const cached = await getSetting<{ boards: MondayBoard[]; listed_at: string }>(db, "monday_board_list");
  if (cached && !refresh && Date.now() - Date.parse(cached.listed_at) < LIST_TTL_MS) return cached;
  const fresh = { boards: await listBoards(env), listed_at: nowIso() };
  await setSetting(db, "monday_board_list", fresh);
  // Vai para os logs do GoDeploy para conferir a lista sem abrir a tela.
  const lines = fresh.boards.map((b) => `${b.id}|${b.name}|${b.workspace ?? "-"}|${b.items ?? "?"}|${(b.updated_at ?? "").slice(0, 10)}`);
  console.log(`[monday] ${lines.length} quadros`);
  for (let i = 0; i < lines.length; i += 60) console.log(`[monday] quadros ${i + 1}-${Math.min(i + 60, lines.length)}: ${lines.slice(i, i + 60).join(" ; ")}`);
  return fresh;
}

export async function setSelectedBoards(db: DB, env: Env, ids: string[]): Promise<SelectedBoard[]> {
  const { boards } = await boardList(db, env);
  const byId = new Map(boards.map((b) => [b.id, b]));
  const sel = [...new Set(ids.map(String))].filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)!.name }));
  await setSetting(db, "monday_boards", sel);
  return sel;
}

/**
 * Espelha os itens de um quadro e liga cada um ao pedido pelo código. Na
 * leitura completa traz tudo; nas outras, só a data de alteração de cada item
 * e depois os detalhes dos que mudaram. Grava só o que mudou.
 */
async function syncBoard(db: DB, env: Env, board: { id: string; name: string; columns: { id: string; title: string }[] }, known: Set<string>, full: boolean): Promise<number> {
  const titles = new Map(board.columns.map((c) => [c.id, c.title]));
  const prev = new Map(
    (await all<{ item_id: string; row_hash: string; updated_at: string | null }>(db, `SELECT item_id, row_hash, updated_at FROM monday_items WHERE board_id = ?`, [board.id])).map((r) => [r.item_id, r]),
  );
  let items: MondayItem[];
  let total: number;
  if (full) {
    items = await boardItems(env, board.id, titles);
    total = items.length;
  } else {
    const stamps = await boardItemStamps(env, board.id);
    total = stamps.size;
    const changed = [...stamps].filter(([id, at]) => (prev.get(id)?.updated_at ?? null) !== (at || null)).map(([id]) => id);
    items = changed.length ? await itemsByIds(env, changed, titles) : [];
  }
  const written = await saveItems(db, board.id, items, known, new Map([...prev].map(([id, r]) => [id, r.row_hash])));
  const linked = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM monday_items WHERE board_id = ? AND matched_by IS NOT NULL`, [board.id]);
  console.log(`[monday] ${board.name}: ${total} itens, ${full ? "leitura completa" : `${items.length} alterados`}, gravados ${written}, ligados a pedido ${linked?.n ?? 0}`);
  return total;
}

/** Grava itens no espelho, ligados aos pedidos pelo código. Só regrava o que mudou. */
export async function saveItems(db: DB, boardId: string, items: MondayItem[], known: Set<string>, prevHashes?: Map<string, string>): Promise<number> {
  const prev =
    prevHashes ??
    new Map((await all<{ item_id: string; row_hash: string }>(db, `SELECT item_id, row_hash FROM monday_items WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(items.map((i) => i.id))])).map((r) => [r.item_id, r.row_hash]));
  const rows: Record<string, unknown>[] = [];
  for (const it of items) {
    const { codes, by: where } = findCodes(it, known);
    const row = { item_id: it.id, board_id: boardId, name: it.name, group_title: it.group, updated_at: it.updated_at, url: it.url, vals: JSON.stringify(it.values), process_codes: JSON.stringify(codes), matched_by: where };
    const h = hash(JSON.stringify(row));
    if (prev.get(it.id) !== h) rows.push({ ...row, row_hash: h });
  }
  await upsertJson(db, "monday_items", ["item_id", "board_id", "name", "group_title", "updated_at", "url", "vals", "process_codes", "matched_by", "row_hash"], ["item_id"], rows);
  return rows.length;
}

export interface BoardMeta {
  id: string;
  name: string;
  columns: MondayColumn[];
}

/** Colunas dos quadros escolhidos, guardadas pela última rodada do Monday. */
export async function boardMeta(db: DB): Promise<Map<string, BoardMeta>> {
  const saved = await getSetting<{ boards: BoardMeta[] }>(db, "monday_columns");
  return new Map((saved?.boards ?? []).map((b) => [b.id, b]));
}

/** Amostras recentes do Warehouse Samples, do espelho no banco, para a ligação com os pedidos. */
async function recentSamples(db: DB, days: number): Promise<MondayItem[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await all(db, `SELECT item_id, name, group_title, updated_at, url, vals FROM monday_items WHERE board_id = ? AND updated_at >= ?`, [WAREHOUSE_SAMPLES, since]);
  return rows.map((r) => ({ id: r.item_id, name: r.name, group: r.group_title, updated_at: r.updated_at, url: r.url, values: JSON.parse(r.vals ?? "{}") }));
}

/**
 * Rotina do Monday (fase 1, só leitura): mantém a lista de quadros, guarda as
 * colunas dos quadros escolhidos, espelha os itens ligados aos pedidos e liga
 * as amostras do Warehouse Samples.
 */
export async function refreshMonday(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!mondayConfigured(env)) return { skipped: "MONDAY_TOKEN não configurado" };
  const { boards } = await boardList(db, env);
  const sel = await selectedBoards(db);
  const cols = await boardColumns(env, sel.map((s) => s.id));
  await setSetting(db, "monday_columns", { at: nowIso(), boards: cols });
  const known = new Set((await all<{ process_code: string }>(db, `SELECT process_code FROM orders`)).map((r) => r.process_code));
  // Uma leitura completa por dia pega o que não mexe na data do item (ex.: colunas espelhadas de outro quadro).
  const lastFull = await getSetting<string>(db, "monday_full_at");
  const full = !lastFull || Date.now() - Date.parse(lastFull) > FULL_EVERY_MS;
  let total = 0;
  let ok = true;
  for (const b of cols) {
    try {
      total += await syncBoard(db, env, b, known, full);
      if (b.id === WAREHOUSE_SAMPLES) await linkSamples(db, env, await recentSamples(db, SAMPLE_DAYS), known);
    } catch (err) {
      ok = false;
      console.log(`[monday] erro no quadro ${b.name}: ${(err as Error).message}`);
    }
  }
  if (full && ok) await setSetting(db, "monday_full_at", nowIso());
  return { boards: boards.length, selected: sel.length, items: total, full };
}
