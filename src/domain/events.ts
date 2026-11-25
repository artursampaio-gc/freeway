import type { DB } from "../env";
import { nowIso, upsertJson } from "../db/q";

export interface NewEvent {
  process_code: string;
  pi_number?: string | null;
  step_key?: string | null;
  type: string;
  message: string;
  old_value?: string | null;
  new_value?: string | null;
  /** E-mail de quem fez, ou "planilha", "fedex", "sistema". */
  actor: string;
  /** Link opcional levado para a notificação (ex.: vídeos). */
  link?: string | null;
  /** Como o pedido aparece (BBI25137, ou BBI25205.2 se foi dividido). Só para a notificação. */
  unit_label?: string;
}

/** Com um frete só o pedido mantém o código; com mais de um, cada frete é BBI25205.N. */
export function unitLabel(code: string, pi: string | null | undefined, freights: number): string {
  return pi && freights > 1 ? pi.replace(/-(\d+)$/, ".$1") : code;
}

export async function insertEvents(db: DB, events: NewEvent[]): Promise<void> {
  if (!events.length) return;
  const now = nowIso();
  await upsertJson(
    db,
    "events",
    ["process_code", "pi_number", "step_key", "type", "message", "old_value", "new_value", "actor", "created_at"],
    ["id"],
    events.map((e) => ({ ...e, created_at: now })),
    { updateCols: [] },
  );
}
