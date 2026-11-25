import type { DB } from "../env";
import { nowIso, one, run } from "../db/q";
import { insertEvents } from "./events";
import { deliver } from "./notify";

export type HoldState = "cancelado" | "on_hold";

const DID: Record<HoldState, string> = { cancelado: "cancelado", on_hold: "colocado on hold" };

/**
 * Cancela, deixa on hold ou reativa (state null) o pedido todo, com todos os fretes.
 * Fica na linha do tempo e avisa quem segue o pedido (menos quem marcou). Devolve se mudou algo.
 */
export async function setOrderHold(db: DB, code: string, state: HoldState | null, note: string | null, user: string): Promise<boolean> {
  const clean = note?.trim().slice(0, 300) || null;
  const prev = await one<{ state: HoldState; note: string | null }>(db, `SELECT state, note FROM order_hold WHERE process_code = ?`, [code]);
  if ((prev?.state ?? null) === state && (!state || (prev?.note ?? null) === clean)) return false;
  if (state) {
    await run(
      db,
      `INSERT INTO order_hold (process_code, state, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(process_code) DO UPDATE SET state = excluded.state, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [code, state, clean, user, nowIso()],
    );
  } else {
    await run(db, `DELETE FROM order_hold WHERE process_code = ?`, [code]);
  }
  const msg = state ? `Pedido ${DID[state]} no Freeway` : `Pedido reativado no Freeway (estava ${prev?.state === "cancelado" ? "cancelado" : "on hold"})`;
  await insertEvents(db, [{ process_code: code, type: "situacao", message: state && clean ? `${msg}: ${clean}` : msg, old_value: prev?.state ?? null, new_value: state, actor: user }]);
  const title = state === "cancelado" ? `${code} foi cancelado` : state === "on_hold" ? `${code} está on hold` : `${code} foi reativado`;
  await deliver(db, [
    {
      nkey: `situacao:${code}:${state ?? "ativo"}:${nowIso()}`,
      process_code: code,
      kind: "situacao",
      title,
      body: [state ? clean : null, `Por ${user}, no Freeway.`].filter(Boolean).join(" · "),
      exclude: user,
    },
  ]);
  return true;
}
