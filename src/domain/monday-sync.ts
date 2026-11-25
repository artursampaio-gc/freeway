import type { DB, Env } from "../env";
import { all, nowIso, one, run, upsertJson } from "../db/q";
import { boardColumns, itemsByIds, itemsWithSubitems, mondayConfigured, writeColumns, type MondayColumn, type RawItem } from "../integrations/monday";
import { APPROVAL_LABEL, fmtDate } from "../shared/labels";
import type { OrderView, StepStatus } from "../shared/types";
import { HttpError } from "./actions";
import { insertEvents, type NewEvent } from "./events";
import { boardMeta, saveItems, type BoardMeta } from "./monday";
import { STEP_BY_KEY } from "./steps";
import { loadViews } from "./view";

// Atualizações do Freeway para o Monday, por enquanto só quando alguém aperta
// "Enviar todos marcados" na página do pedido. Sugestão marcada como incorreta (X) não volta enquanto for a mesma. A prévia lê o Monday ao vivo (itens e
// subelementos). Regras conservadoras: só propõe quando o Freeway tem o valor,
// nunca apaga nada no Monday e, em coluna de status, só usa rótulos que já
// existem no quadro.

export interface MondayUpdate {
  /** item:coluna */
  id: string;
  item_id: string;
  board_id: string;
  board: string;
  item: string;
  /** Nome do subelemento (Mockups, Importação…), quando a mudança é num subelemento. */
  sub: string | null;
  url: string | null;
  column_id: string;
  column: string;
  from: string | null;
  to: string;
  why: string;
  value: unknown;
}

interface Target {
  item_id: string;
  board_id: string;
  board: string;
  item: string;
  sub: string | null;
  url: string | null;
  columns: MondayColumn[];
  vals: Record<string, string>;
}

// Etapa atual do Freeway → rótulos de status que podem corresponder (o 1º que existir no quadro).
const STAGE_PATTERNS: Record<string, RegExp[]> = {
  amostra: [/sample|amostra/i],
  producao: [/produ/i],
  importacao: [/import|trânsito|transit|embarc|ship|frete/i],
  sefaz: [/desembara|custom|clearance|sefaz/i],
  chegada: [/cheg|entreg|recebid|arriv|deliver/i],
  fci: [/fci|itapeva|industrial/i],
  industrializacao: [/itapeva|industrial/i],
  mockups: [/mockup|cadastro|site|e-?commerce/i],
  cadastro_site: [/cadastro|site|e-?commerce/i],
  cadastro_wms: [/wms|cadastro|site/i],
  lancamento: [/lançament|launch|pré-lan/i],
  lancado: [/lançad|launched|no ar/i],
};
const STAGE_ORDER = ["amostra", "producao", "importacao", "sefaz", "chegada", "fci", "industrializacao", "mockups", "cadastro_site", "cadastro_wms", "lancamento"];

// Situação de uma etapa → rótulos de status de subelemento ("Feito", "Em Desenvolvimento", "Aguardando"…).
const STATE_PATTERNS: Record<"done" | "doing" | "todo", RegExp[]> = {
  done: [/^feito$/i, /done|conclu|pronto|finaliz/i],
  doing: [/desenvolv|andamento|working|progress|fazendo|execu/i],
  todo: [/aguard|wait|pendente|not started|a fazer|n[aã]o inici/i],
};
const STATE_WORD = { done: "concluída", doing: "em andamento", todo: "ainda não começou" };

const APPROVAL_PATTERNS: Record<string, RegExp[]> = {
  aprovado: [/^approved$/i, /^aprovad[ao]$/i],
  aprovado_restricao: [/restri/i],
  reprovado: [/not approved|reprovad/i],
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const pickLabel = (c: MondayColumn, patterns: RegExp[]) => {
  for (const re of patterns) {
    const hit = (c.labels ?? []).find((l) => re.test(l));
    if (hit) return hit;
  }
  return null;
};

type Agg = { state: "done" | "doing" | "todo"; due: string | null } | null;

/** Situação de uma etapa no pedido inteiro: concluída só se todos os fretes concluíram. */
function agg(v: OrderView, key: string): Agg {
  const def = STEP_BY_KEY[key];
  const steps = (def?.scope === "order" ? v.steps.filter((s) => s.key === key) : v.units.map((u) => u.steps.find((s) => s.key === key)))
    .filter((s): s is NonNullable<typeof s> => !!s && s.status !== "na");
  if (!steps.length) return null;
  const open = steps.filter((s) => s.status !== "done");
  const started = (st: StepStatus) => st !== "todo";
  const due = open.map((s) => s.due).filter(Boolean).sort()[0] ?? null;
  if (!open.length) return { state: "done", due: null };
  return { state: steps.some((s) => started(s.status)) ? "doing" : "todo", due };
}

/** Importação no Monday vai do embarque até a chegada no destino (no Freeway: importação, desembaraço e chegada). */
function aggImport(v: OrderView): Agg {
  const imp = agg(v, "importacao");
  const che = agg(v, "chegada");
  if (!imp) return null;
  if (che?.state === "done") return { state: "done", due: null };
  const ships = v.units.map((u) => u.shipment).filter((s) => s && s.status !== "entregue");
  const due = ships.map((s) => s!.delivery_forecast ?? s!.eta).filter(Boolean).sort()[0] ?? null;
  return { state: imp.state === "todo" ? "todo" : "doing", due };
}

/** Cadastro no Monday = site e WMS. */
function aggCadastro(v: OrderView): Agg {
  const a = agg(v, "cadastro_site");
  const b = agg(v, "cadastro_wms");
  if (!a && !b) return null;
  const states = [a, b].filter(Boolean).map((x) => x!.state);
  return { state: states.every((s) => s === "done") ? "done" : states.some((s) => s !== "todo") ? "doing" : "todo", due: [a?.due, b?.due].filter(Boolean).sort()[0] ?? null };
}

// Subelemento pelo nome → situação no Freeway.
const SUBITEMS: { re: RegExp; label: string; get: (v: OrderView) => Agg }[] = [
  { re: /mockup/i, label: "Mockups", get: (v) => agg(v, "mockups") },
  { re: /cadastro/i, label: "Cadastro (site e WMS)", get: aggCadastro },
  { re: /produ/i, label: "Produção", get: (v) => agg(v, "producao") },
  { re: /importa/i, label: "Importação até a chegada", get: aggImport },
  { re: /itapeva|industrial/i, label: "Industrialização em Itapeva", get: (v) => agg(v, "industrializacao") },
  { re: /^fci$/i, label: "FCI", get: (v) => agg(v, "fci") },
  { re: /lançament|launch/i, label: "Lançamento", get: (v) => agg(v, "lancamento") },
  { re: /amostra|sample/i, label: "Amostra", get: (v) => agg(v, "amostra") },
];

/** Etapa atual do pedido: a primeira em aberto na ordem da operação e depois do site. */
function currentStage(v: OrderView): string {
  for (const key of STAGE_ORDER) {
    const a = agg(v, key);
    if (a && a.state !== "done") return key;
  }
  return "lancado";
}

function proposals(v: OrderView, t: Target): MondayUpdate[] {
  const out: MondayUpdate[] = [];
  const col = (re: RegExp, type?: string) => t.columns.find((c) => re.test(c.title.trim()) && (!type || c.type === type));
  const add = (c: MondayColumn | undefined, to: string | null, value: unknown, why: string) => {
    if (!c || !to) return;
    const from = t.vals[c.title] ?? null;
    if (c.type === "date" ? (from ?? "").slice(0, 10) === to : norm(from) === norm(to)) return;
    out.push({ id: `${t.item_id}:${c.id}`, item_id: t.item_id, board_id: t.board_id, board: t.board, item: t.item, sub: t.sub, url: t.url, column_id: c.id, column: c.title, from, to, why, value });
  };
  const status = (c: MondayColumn | undefined, patterns: RegExp[], why: string) => {
    if (c?.type !== "status") return;
    const label = pickLabel(c, patterns);
    if (label) add(c, label, { label }, why);
  };
  const date = (c: MondayColumn | undefined, d: string | null | undefined, why: string) => {
    if (c?.type === "date" && d) add(c, d.slice(0, 10), { date: d.slice(0, 10) }, why);
  };

  // Subelemento: status e previsão da etapa correspondente.
  if (t.sub) {
    const rule = SUBITEMS.find((r) => r.re.test(t.sub!));
    const a = rule?.get(v);
    if (!rule || !a) return out;
    status(col(/^status$/i, "status") ?? t.columns.find((c) => c.type === "status"), STATE_PATTERNS[a.state], `Freeway: ${rule.label} ${STATE_WORD[a.state]}`);
    if (a.state !== "done") date(col(/previs|prazo|due|deadline/i, "date"), a.due, `Freeway: previsão de ${rule.label.toLowerCase()}`);
    return out;
  }

  const open = v.units.filter((u) => !u.finalized);
  const stage = currentStage(v);
  const stageWhy = stage === "lancado" ? "Freeway: lançado no site" : `Freeway: etapa atual ${STEP_BY_KEY[stage]?.label ?? stage}`;
  if (/launch/i.test(t.board)) {
    const health = !open.length ? "lancado" : open.some((u) => u.health === "late") ? "late" : open.some((u) => u.health === "risk") ? "risk" : "ok";
    const healthPatterns: Record<string, RegExp[]> = { late: [/delay|atras/i], risk: [/risk|risco/i], ok: [/on track|no prazo|em dia/i], lancado: [/launched|lançad|done|conclu/i] };
    const healthWhy: Record<string, string> = { late: "Freeway: pedido atrasado", risk: "Freeway: pedido em risco", ok: "Freeway: pedido no prazo", lancado: "Freeway: lançado no site" };
    status(col(/^launch status$/i), healthPatterns[health], healthWhy[health]);
    status(col(/^current stage$/i), STAGE_PATTERNS[stage] ?? [], stageWhy);
    const prod = v.steps.find((s) => s.key === "producao");
    const done = prod?.data?.done_at as string | undefined;
    date(col(/^production completion$/i), done ?? prod?.due, done ? `Freeway: produção concluída em ${fmtDate(done, true)}` : "Freeway: prazo previsto da produção");
  }
  if (/novas cases/i.test(t.board)) {
    status(col(/^status$/i, "status"), STAGE_PATTERNS[stage] ?? [], stageWhy);
    const launched = v.units.map((u) => u.launched_at).filter(Boolean) as string[];
    const dues = open.map((u) => u.launch_due).filter(Boolean) as string[];
    const d = !open.length && launched.length ? launched.sort().at(-1) : dues.sort()[0];
    date(col(/^lançamento$/i), d, !open.length ? "Freeway: lançado no site" : "Freeway: data de lançamento prevista");
  }
  if (/warehouse samples/i.test(t.board)) {
    const am = v.steps.find((s) => s.key === "amostra")?.data ?? {};
    if (am.approval) {
      status(col(/^approval$/i), APPROVAL_PATTERNS[am.approval] ?? [], `Freeway: ${APPROVAL_LABEL[am.approval] ?? am.approval}${am.approval_by ? ` por ${am.approval_by}` : ""}${am.approval_at ? ` em ${fmtDate(am.approval_at, true)}` : ""}`);
    }
  }
  return out;
}

/** Itens do Monday ligados ao pedido: pelo código no item ou pela ligação das amostras. */
async function linkedItems(db: DB, code: string) {
  return all<{ item_id: string; board_id: string; name: string; url: string | null; vals: string }>(
    db,
    `SELECT m.item_id, m.board_id, m.name, m.url, m.vals FROM monday_items m
      WHERE EXISTS (SELECT 1 FROM json_each(m.process_codes) c WHERE c.value = ?)
         OR m.item_id IN (SELECT l.item_id FROM sample_links l, json_each(l.process_codes) c
                           WHERE c.value = ? AND (l.status IN ('auto', 'confirmado') OR EXISTS (SELECT 1 FROM json_each(l.confirmed) k WHERE k.value = ?)))`,
    [code, code, code],
  );
}

/** Colunas dos quadros de subelementos (guardadas por um dia). */
async function subBoardMeta(db: DB, env: Env, ids: string[]): Promise<Map<string, BoardMeta>> {
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'monday_subboards'`);
  const saved: { at: string; boards: BoardMeta[] } = row ? JSON.parse(row.value) : { at: "", boards: [] };
  const fresh = Date.now() - Date.parse(saved.at || "1970-01-01") < 24 * 3600 * 1000;
  const have = new Map(saved.boards.map((b) => [b.id, b]));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length || (!fresh && ids.length)) {
    for (const b of await boardColumns(env, fresh ? missing : [...new Set([...ids, ...have.keys()])])) have.set(b.id, { id: b.id, name: b.name, columns: b.columns });
    await run(db, `INSERT INTO settings (key, value) VALUES ('monday_subboards', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
      JSON.stringify({ at: nowIso(), boards: [...have.values()] }),
    ]);
  }
  return have;
}

const toVals = (raw: { id: string; text: string | null }[], columns: MondayColumn[]) => {
  const title = new Map(columns.map((c) => [c.id, c.title]));
  const out: Record<string, string> = {};
  for (const cv of raw) if (cv.text && title.has(cv.id)) out[title.get(cv.id)!] = cv.text;
  return out;
};

/**
 * Atualizações pendentes do pedido para o Monday. Lê os itens ligados e os
 * subelementos ao vivo; se o Monday não responder, usa o espelho (sem subelementos).
 */
export async function pendingUpdates(db: DB, env: Env, code: string, user?: string): Promise<{ items: number; updates: MondayUpdate[]; dismissed: MondayUpdate[]; live: boolean; boards: Map<string, BoardMeta> }> {
  const [v] = await loadViews(db, [code], user);
  if (!v) throw new HttpError(404, `Processo ${code} não encontrado`);
  const [linked, boards] = await Promise.all([linkedItems(db, code), boardMeta(db)]);
  const targets: Target[] = [];
  let live = false;
  if (linked.length && mondayConfigured(env)) {
    try {
      const raw = await itemsWithSubitems(env, linked.map((l) => l.item_id));
      const subIds = [...new Set(raw.flatMap((r) => r.subitems.map((s) => s.board_id).filter(Boolean) as string[]))];
      const subs = subIds.length ? await subBoardMeta(db, env, subIds) : new Map<string, BoardMeta>();
      for (const [id, b] of subs) boards.set(id, b);
      for (const r of raw) {
        const board = boards.get(linked.find((l) => l.item_id === r.id)?.board_id ?? "");
        if (!board) continue;
        targets.push({ item_id: r.id, board_id: board.id, board: board.name, item: r.name, sub: null, url: r.url, columns: board.columns, vals: toVals(r.values, board.columns) });
        for (const s of r.subitems as RawItem[]) {
          const sb = s.board_id ? subs.get(s.board_id) : undefined;
          if (sb) targets.push({ item_id: s.id, board_id: sb.id, board: board.name, item: r.name, sub: s.name, url: s.url ?? r.url, columns: sb.columns, vals: toVals(s.values, sb.columns) });
        }
      }
      live = true;
    } catch (err) {
      console.log(`[monday-sync] leitura ao vivo falhou (${code}): ${(err as Error).message}`);
    }
  }
  if (!live) {
    for (const l of linked) {
      const board = boards.get(l.board_id);
      if (board) targets.push({ item_id: l.item_id, board_id: board.id, board: board.name, item: l.name, sub: null, url: l.url, columns: board.columns, vals: JSON.parse(l.vals ?? "{}") });
    }
  }
  // Marcadas como incorretas: ficam de fora enquanto a sugestão for a mesma (valor e motivo). Se a leitura dos dados
  // passar a sugerir outra coisa naquele campo, a marca antiga sai e a sugestão nova aparece.
  const all_ = targets.flatMap((t) => proposals(v, t));
  const marks = new Map((await all<{ update_id: string; to_value: string; why: string }>(db, `SELECT update_id, to_value, why FROM monday_dismissed WHERE process_code = ?`, [code])).map((r) => [r.update_id, r]));
  const updates: MondayUpdate[] = [];
  const dismissed: MondayUpdate[] = [];
  const stale: string[] = [];
  for (const u of all_) {
    const mk = marks.get(u.id);
    if (mk && mk.to_value === u.to && mk.why === u.why) dismissed.push(u);
    else {
      if (mk) stale.push(u.id);
      updates.push(u);
    }
  }
  if (stale.length) await run(db, `DELETE FROM monday_dismissed WHERE process_code = ? AND update_id IN (SELECT value FROM json_each(?))`, [code, JSON.stringify(stale)]);
  return { items: linked.length, updates, dismissed, live, boards };
}

/** Marca atualizações sugeridas como incorretas (interpretação errada), com registro na linha do tempo. */
export async function dismissUpdates(db: DB, code: string, list: { id: string; to: string; why: string; label: string }[], user: string): Promise<number> {
  const now = nowIso();
  for (const u of list) {
    await run(
      db,
      `INSERT INTO monday_dismissed (process_code, update_id, to_value, why, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(process_code, update_id) DO UPDATE SET to_value = excluded.to_value, why = excluded.why, dismissed_by = excluded.dismissed_by, dismissed_at = excluded.dismissed_at`,
      [code, u.id, u.to, u.why, user, now],
    );
  }
  const labels = [...new Set(list.map((u) => u.label))];
  if (labels.length) {
    await insertEvents(db, labels.map((l) => ({ process_code: code, type: "monday_sync", actor: user, message: `Sugestão para o Monday marcada como incorreta: ${l}` })));
  }
  return list.length;
}

/** Volta a sugerir atualizações marcadas como incorretas. */
export async function restoreUpdates(db: DB, code: string, ids: string[]): Promise<number> {
  return run(db, `DELETE FROM monday_dismissed WHERE process_code = ? AND update_id IN (SELECT value FROM json_each(?))`, [code, JSON.stringify(ids)]);
}

/**
 * Sincroniza com o Monday as atualizações escolhidas. `picks` traz o valor que
 * a pessoa viu na prévia; antes de escrever, o Freeway relê o item no Monday e,
 * se o valor mudou lá desde então, pula essa linha.
 */
export async function syncMonday(db: DB, env: Env, code: string, picks: { id: string; from: string | null }[], user: string) {
  if (!mondayConfigured(env)) throw new HttpError(400, "Falta o token do Monday");
  const { updates, boards } = await pendingUpdates(db, env, code, user);
  const seen = new Map(picks.map((p) => [p.id, p.from]));
  const chosen = updates.filter((u) => seen.has(u.id)).map((u) => ({ ...u, from: seen.get(u.id) ?? null }));
  const mainBoards = await boardMeta(db);
  const result = { escritos: [] as string[], pulados: [] as { id: string; motivo: string }[], erros: [] as { id: string; erro: string }[] };
  const byItem = new Map<string, MondayUpdate[]>();
  for (const u of chosen) byItem.set(u.item_id, [...(byItem.get(u.item_id) ?? []), u]);

  const events: NewEvent[] = [];
  const audit: Record<string, unknown>[] = [];
  const touched = new Map<string, string[]>();
  for (const [itemId, list] of byItem) {
    const board = boards.get(list[0].board_id)!;
    const [fresh] = await itemsByIds(env, [itemId], new Map(board.columns.map((c) => [c.id, c.title])));
    const ok: MondayUpdate[] = [];
    for (const u of list) {
      const now = fresh?.values[u.column] ?? null;
      const isDate = !!u.value && typeof u.value === "object" && "date" in (u.value as object);
      const same = (a: string | null, b: string | null) => (isDate ? (a ?? "").slice(0, 10) === (b ?? "").slice(0, 10) : norm(a) === norm(b));
      if (!fresh) result.pulados.push({ id: u.id, motivo: "item não encontrado no Monday" });
      else if (same(now, u.to)) result.pulados.push({ id: u.id, motivo: "já estava assim no Monday" });
      else if (!same(now, u.from)) result.pulados.push({ id: u.id, motivo: `mudou no Monday desde a prévia (agora: ${now ?? "vazio"})` });
      else ok.push(u);
    }
    if (!ok.length) continue;
    try {
      await writeColumns(env, board.id, itemId, Object.fromEntries(ok.map((u) => [u.column_id, u.value])));
      for (const u of ok) {
        result.escritos.push(u.id);
        const where = u.sub ? `${u.item} › ${u.sub}` : u.item;
        events.push({ process_code: code, type: "monday_sync", actor: user, message: `Monday atualizado: [${u.board}] ${where} · ${u.column}: ${u.from ?? "vazio"} → ${u.to}` });
        audit.push({ item_id: itemId, board_id: board.id, column_id: u.column_id, value: u.to, process_code: code, written_by: user, written_at: nowIso() });
      }
      if (mainBoards.has(board.id)) touched.set(board.id, [...(touched.get(board.id) ?? []), itemId]);
    } catch (err) {
      for (const u of ok) result.erros.push({ id: u.id, erro: (err as Error).message.slice(0, 300) });
    }
  }
  await insertEvents(db, events);
  await upsertJson(db, "monday_writes", ["item_id", "board_id", "column_id", "value", "process_code", "written_by", "written_at"], ["id"], audit, { updateCols: [] });
  // Atualiza o espelho dos itens (os subelementos não ficam no espelho: a prévia os lê ao vivo).
  const known = new Set((await all<{ process_code: string }>(db, `SELECT process_code FROM orders`)).map((r) => r.process_code));
  for (const [boardId, itemIds] of touched) {
    const board = boards.get(boardId)!;
    await saveItems(db, boardId, await itemsByIds(env, itemIds, new Map(board.columns.map((c) => [c.id, c.title]))), known);
  }
  console.log(`[monday-sync] ${code} por ${user}: ${JSON.stringify({ escritos: result.escritos.length, pulados: result.pulados.length, erros: result.erros.length })}`);
  return result;
}
