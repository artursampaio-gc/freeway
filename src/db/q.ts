import type { DB } from "../env";

export async function all<T = Record<string, any>>(db: DB, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params);
  return res.rows as T[];
}

export async function one<T = Record<string, any>>(db: DB, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await all<T>(db, sql, params);
  return rows[0] ?? null;
}

export async function run(db: DB, sql: string, params: unknown[] = []): Promise<number> {
  const res = await db.exec(sql, params);
  return res.rowsWritten;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Upsert de muitas linhas numa chamada só por lote: as linhas vão como um
 * parâmetro JSON e o SQLite as expande com json_each. env.DB não tem batch,
 * então isso evita uma chamada por linha.
 */
export async function upsertJson(
  db: DB,
  table: string,
  cols: string[],
  keyCols: string[],
  rows: Record<string, unknown>[],
  opts: { updateCols?: string[]; chunkSize?: number } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const updateCols = opts.updateCols ?? cols.filter((c) => !keyCols.includes(c));
  const select = cols.map((c) => `json_extract(value, '$.${c}')`).join(", ");
  const conflict = updateCols.length
    ? `ON CONFLICT(${keyCols.join(", ")}) DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(", ")}`
    : `ON CONFLICT(${keyCols.join(", ")}) DO NOTHING`;
  // "WHERE true" evita a ambiguidade de parse do SQLite entre SELECT e ON CONFLICT.
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) SELECT ${select} FROM json_each(?) WHERE true ${conflict}`;
  let written = 0;
  for (const part of chunk(rows, opts.chunkSize ?? 250)) {
    const payload = part.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of cols) o[c] = r[c] ?? null;
      return o;
    });
    written += await run(db, sql, [JSON.stringify(payload)]);
  }
  return written;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Data de hoje no fuso de Brasília (YYYY-MM-DD). */
export function todayBR(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
