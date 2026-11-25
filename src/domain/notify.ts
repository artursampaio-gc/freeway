import type { DB } from "../env";
import { all, nowIso, one, run, upsertJson } from "../db/q";

export interface NotificationSpec {
  /** Chave única: a mesma chave nunca gera duas notificações. */
  nkey: string;
  process_code: string;
  pi_number?: string | null;
  step_key?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  /** Times que recebem, além de quem observa. */
  teams?: string[];
  /** Avisa quem observa o pedido (padrão: sim). */
  watchers?: boolean;
  /** Quem causou o aviso não precisa recebê-lo. */
  exclude?: string | null;
}

/**
 * Cria as notificações e seus destinatários. Pedidos que ninguém observa
 * ficam inativos e não geram aviso. Devolve quantas notificações novas saíram.
 */
export async function deliver(db: DB, specs: NotificationSpec[]): Promise<number> {
  if (!specs.length) return 0;
  const codes = [...new Set(specs.map((s) => s.process_code))];
  const watchRows = await all<{ process_code: string; user_email: string }>(
    db,
    `SELECT process_code, user_email FROM watchers WHERE process_code IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(codes)],
  );
  const watchersBy = new Map<string, string[]>();
  for (const w of watchRows) watchersBy.set(w.process_code, [...(watchersBy.get(w.process_code) ?? []), w.user_email]);
  // Avisos de um lançamento (desenvolvimento) vão para quem observa o lançamento.
  const devIds = codes.filter((c) => c.startsWith("dev:")).map((c) => c.slice(4));
  if (devIds.length) {
    for (const w of await all<{ item_id: string; user_email: string }>(db, `SELECT item_id, user_email FROM dev_watchers WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(devIds)])) {
      watchersBy.set(`dev:${w.item_id}`, [...(watchersBy.get(`dev:${w.item_id}`) ?? []), w.user_email]);
    }
  }
  const teamRows = await all<{ team_key: string; user_email: string }>(db, `SELECT team_key, user_email FROM team_members`);

  let created = 0;
  const now = nowIso();
  for (const s of specs) {
    const watchers = watchersBy.get(s.process_code);
    if (!watchers?.length) continue;

    const recipients = new Map<string, string>();
    for (const t of s.teams ?? []) {
      for (const m of teamRows) if (m.team_key === t) recipients.set(m.user_email, `time:${t}`);
    }
    if (s.watchers !== false) for (const w of watchers) if (!recipients.has(w)) recipients.set(w, "observa");
    if (s.exclude) recipients.delete(s.exclude);
    if (!recipients.size) continue;

    if (await one(db, `SELECT 1 FROM notifications WHERE nkey = ?`, [s.nkey])) continue;
    await run(
      db,
      `INSERT OR IGNORE INTO notifications (nkey, process_code, pi_number, step_key, kind, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.nkey, s.process_code, s.pi_number ?? null, s.step_key ?? null, s.kind, s.title, s.body ?? null, now],
    );
    const row = await one<{ id: number }>(db, `SELECT id FROM notifications WHERE nkey = ?`, [s.nkey]);
    if (!row) continue;
    await upsertJson(
      db,
      "notification_recipients",
      ["notification_id", "user_email", "reason"],
      ["notification_id", "user_email"],
      [...recipients].map(([user_email, reason]) => ({ notification_id: row.id, user_email, reason })),
      { updateCols: [] },
    );
    created++;
  }
  return created;
}
