import type { DB, Env } from "../env";
import { all, nowIso, one, run, todayBR } from "../db/q";
import { unitLabel } from "../domain/events";
import { deliver, type NotificationSpec } from "../domain/notify";
import { accessToken, fetchRanges } from "../sheet/google";
import type { FiscalNoteView, StepStatus } from "../shared/types";

// Planilha "Notas de Importação" do time de notas/FCI (dono: Luciano Cavalcante).
// O Freeway confere o acesso, lê as notas e liga cada processo aos embarques; a trilha fiscal ainda não mostra os dados.

export const FISCAL_SHEET_ID = "19ojda-88gFPJWQsKnPmzj8qkuX12a0FUts-AYC_TTa8";
const sheetId = (env: Env) => env.FISCAL_SHEET_ID?.trim() || FISCAL_SHEET_ID;
/** Com acesso, confere de novo a cada 6 h; sem acesso, a cada rodada (30 min), para perceber logo quando compartilharem. */
const RECHECK_OK_MS = 6 * 3600 * 1000;

export interface FiscalAccess {
  ok: boolean;
  checked_at: string;
  title?: string;
  tabs?: string[];
  tab?: string;
  rows?: number;
  summary?: string;
  error?: string;
  /** Processos ligados a embarques na última leitura. */
  linked?: number;
}

export const fiscalConfigured = (env: Env): boolean => !!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY);

/** Tenta ler a planilha com a conta de serviço e guarda o resultado (settings.fiscal_access). */
export async function checkFiscalAccess(db: DB, env: Env): Promise<FiscalAccess> {
  const checked_at = nowIso();
  let out: FiscalAccess;
  try {
    const auth = await accessToken(env);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId(env)}?fields=properties.title,sheets.properties.title`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
    if (res.status === 403 || res.status === 404) {
      out = { ok: false, checked_at, error: `a conta de serviço ${env.GOOGLE_SA_EMAIL} ainda não tem acesso à planilha` };
    } else if (!res.ok) {
      out = { ok: false, checked_at, error: `Sheets API ${res.status}` };
    } else {
      const meta = (await res.json()) as { properties?: { title?: string }; sheets?: { properties: { title: string } }[] };
      const tabs = (meta.sheets ?? []).map((s) => s.properties.title);
      const tab = tabs.find((t) => /notas/i.test(t)) ?? tabs[0];
      const grid = tab ? (await fetchRanges(env, sheetId(env), [`'${tab.replace(/'/g, "''")}'!A1:P`]))[tab] ?? [] : [];
      out = { ok: true, checked_at, title: meta.properties?.title, tabs, tab, rows: Math.max(0, grid.length - 2), summary: String(grid[0]?.[0] ?? "").slice(0, 200) };
    }
  } catch (e) {
    out = { ok: false, checked_at, error: (e as Error).message.slice(0, 300) };
  }
  await run(db, `INSERT INTO settings (key, value) VALUES ('fiscal_access', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(out)]);
  return out;
}

export async function fiscalAccess(db: DB): Promise<FiscalAccess | null> {
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'fiscal_access'`);
  return row ? (JSON.parse(row.value) as FiscalAccess) : null;
}

/** Na rotina da planilha: confere só quando está na hora (ver RECHECK_OK_MS). */
export async function maybeCheckFiscal(db: DB, env: Env): Promise<FiscalAccess | null> {
  if (!fiscalConfigured(env)) return null;
  const last = await fiscalAccess(db);
  if (last?.ok && Date.now() - Date.parse(last.checked_at) < RECHECK_OK_MS) return null;
  return checkFiscalAccess(db, env);
}

// ---------- Como a nota aparece no frete ----------

const STAGES = ["Extrato da DUIMP", "Planilha do despachante", "Conferência", "Grokbot", "Lançada no WebGex", "Emitida"];

/** ✅ feito · ⛔/❌/🔴 travado · ⚠️/🟠 a conferir · ⏳ andando · vazio ainda não. */
function markOf(v: string): FiscalNoteView["etapas"][number]["mark"] {
  if (!v || /^[—–-]+$/.test(v)) return "todo";
  if (v.startsWith("✅")) return "done";
  if (v.startsWith("⛔") || v.startsWith("❌") || v.startsWith("\u{1F534}")) return "blocked";
  if (v.startsWith("⚠") || v.startsWith("\u{1F7E0}")) return "risk";
  return "doing";
}
/** Tira o emoji do começo ("⛔ Bloqueada no painel" → "Bloqueada no painel"). */
const plain = (v: string) => v.replace(/^[^\p{L}\p{N}]+/u, "").trim();

function brl(v: string | null): string | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || /[^\d.,-]/.test(v.replace(/^R\$\s*/, ""))) return v;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `R$ ${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

/** Número serial de data da planilha (ex.: 46333.41) vira "07/11/2026 09:52"; texto fica como está. */
function serialText(v: string | null): string | null {
  if (!v || !/^\d{5}(\.\d+)?$/.test(v)) return v;
  const d = new Date(Math.round((Number(v) - 25569) * 1440) * 60000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Uma linha de fiscal_notes como o frete mostra: situação, as 6 etapas, DUIMP, NF e o que falta. */
export function fiscalNoteView(raw: string, via: string | null, updated_at: string | null): FiscalNoteView {
  const n = JSON.parse(raw) as FiscalNote & { key?: string };
  const status = n.status ?? "";
  const etapas = STAGES.map((label, i) => {
    const v = String(n.etapas?.[i] ?? "").trim();
    return { label, value: plain(v), mark: markOf(v) };
  });
  const state: StepStatus = /emitid/i.test(status)
    ? "done"
    : /bloque/i.test(status)
      ? "blocked"
      : /erro/i.test(status)
        ? "late"
        : /conferir/i.test(status)
          ? "risk"
          : etapas.some((e) => e.mark !== "todo")
            ? "doing"
            : "todo";
  return {
    processo: n.key ?? n.processo,
    empresa: n.empresa,
    duimp: n.duimp,
    status: plain(status) || null,
    state,
    etapas,
    nf: n.nf,
    valor: brl(n.valor),
    falta: n.falta,
    mudou: serialText(n.mudou),
    via,
    updated_at,
  };
}

// ---------- Avisos: a nota travou (bloqueada ou com erro) ou foi emitida ----------

const FISCAL_NOTIFY: Partial<Record<StepStatus, string>> = { blocked: "bloqueada", late: "com erro", done: "emitida" };

/**
 * Compara a situação de cada nota com a última vista (fiscal_seen) e avisa quem segue o pedido do frete
 * quando ela passa a bloqueada, com erro ou emitida. Na primeira vez que uma nota aparece, só guarda a situação.
 */
export async function notifyFiscalChanges(db: DB, notes: { view: FiscalNoteView; pis: string[] }[]): Promise<number> {
  const seen = new Map(
    (await all<{ processo: string; state: string }>(db, `SELECT processo, state FROM fiscal_seen`)).map((r) => [r.processo, r.state]),
  );
  const pis = [...new Set(notes.flatMap((n) => n.pis))];
  const ships = pis.length
    ? await all<{ pi_number: string; process_code: string; n: number }>(
        db,
        `SELECT s.pi_number, s.process_code, (SELECT COUNT(*) FROM shipments x WHERE x.process_code = s.process_code AND x.removed_at IS NULL) AS n
           FROM shipments s WHERE s.pi_number IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(pis)],
      )
    : [];
  const shipBy = new Map(ships.map((s) => [s.pi_number, s]));
  const today = todayBR();
  const now = nowIso();
  const specs: NotificationSpec[] = [];
  for (const { view: v, pis: list } of notes) {
    const before = seen.get(v.processo);
    if (before !== v.state) {
      await run(
        db,
        `INSERT INTO fiscal_seen (processo, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(processo) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        [v.processo, v.state, now],
      );
    }
    const what = FISCAL_NOTIFY[v.state];
    if (before === undefined || before === v.state || !what) continue;
    for (const pi of list) {
      const s = shipBy.get(pi);
      if (!s) continue;
      const label = unitLabel(s.process_code, pi, s.n);
      const body =
        v.state === "done"
          ? [v.nf && `NF ${v.nf}`, v.valor, v.processo].filter(Boolean).join(" · ")
          : [v.falta ?? v.status, v.processo].filter(Boolean).join(" · ");
      specs.push({
        nkey: `fiscal:${v.processo}:${pi}:${v.state}:${today}`,
        process_code: s.process_code,
        pi_number: pi,
        kind: "fiscal",
        title: `${label}: nota de importação ${what}`,
        body,
      });
    }
  }
  return deliver(db, specs);
}

// ---------- Notas de Importação: leitura e vínculo com os embarques ----------
// Por enquanto só lê, guarda (fiscal_notes) e liga cada processo aos embarques; a trilha fiscal ainda não usa.

export interface FiscalNote {
  /** Como está na coluna Processo (referência da trading ou nome da planilha do despachante). */
  processo: string;
  empresa: string | null;
  duimp: string | null;
  status: string | null;
  /** As 6 etapas: Extrato DUIMP, Planilha, Conferência, Grokbot, Lançada no WebGex, Emitida. */
  etapas: string[];
  nf: string | null;
  valor: string | null;
  falta: string | null;
  mudou: string | null;
}

export interface FiscalRun {
  /** Avisos criados nesta leitura (nota travou ou foi emitida). */
  avisos: number;
  processos: number;
  ligados: number;
  por: Record<string, number>;
  pis: number;
  historico: number;
  precos_fci: number;
  sem_vinculo: string[];
}

const cell = (v: unknown): string | null => {
  const s = v === undefined || v === null ? "" : String(v).trim();
  return s && s !== "—" ? s : null;
};
/** Só letras e números, para comparar códigos escritos de jeitos diferentes (IMP-02/13796 = IMP0213796). */
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** "IMPORTACAO WMFIMP-26-1775.xlsx" (nome da planilha do despachante) vira WMFIMP-26/1775. */
export function fiscalKey(processo: string): string {
  const s = processo.trim().replace(/^IMPORTA[ÇC][ÃA]O\s+/i, "").replace(/\.xlsx?$/i, "").trim().toUpperCase();
  return s.replace(/^([A-Z]+-\d{2})-(\d+)$/, "$1/$2");
}
const digits = (s: string | null | undefined) => (s ? s.replace(/\D/g, "").replace(/^0+/, "") : "");

/** Linhas de NF do Histórico: os códigos da nota (o do Controle PIs e o da trading), a NF e a DUIMP. */
export function parseFiscalHistory(grid: unknown[][]): { refs: string[]; nf: string; duimp: string | null }[] {
  const out: { refs: string[]; nf: string; duimp: string | null }[] = [];
  for (const r of grid) {
    const what = String(r[6] ?? "");
    const m = what.match(/NF de importa[çc][ãa]o n[ºo°]\s*(\d+)\s*\(([^,)]+)[,)]/i);
    if (!m) continue;
    const refs = m[2].split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
    const duimp = String(r[12] ?? "").match(/DUIMP\s+(\d{2}BR[\d-]+)/i)?.[1] ?? null;
    out.push({ refs, nf: m[1], duimp });
  }
  return out;
}

/** Lê as Notas de Importação, liga cada processo aos embarques (Ref Trading / BL, Histórico, NF) e guarda. */
export async function refreshFiscalNotes(db: DB, env: Env): Promise<FiscalRun | null> {
  if (!fiscalConfigured(env)) return null;
  const access = await fiscalAccess(db);
  if (!access?.ok) return null;
  const notesTab = access.tab ?? "Notas de Importação";
  const q = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const tabs = access.tabs ?? [];
  const histTab = tabs.find((t) => /hist/i.test(t));
  const priceTab = tabs.find((t) => /pre[çc]os?\s*fci/i.test(t));
  const grids = await fetchRanges(env, sheetId(env), [
    `${q(notesTab)}!A1:P`,
    ...(histTab ? [`${q(histTab)}!A1:M`] : []),
    ...(priceTab ? [`${q(priceTab)}!A1:A`] : []),
  ]);
  const grid = grids[notesTab] ?? [];
  const hi = grid.findIndex((r) => String(r[0] ?? "").trim() === "Processo");
  if (hi < 0) throw new Error("não achei o cabeçalho (Processo) nas Notas de Importação");
  const head = grid[hi].map((h) => String(h ?? "").trim());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const C = {
    empresa: col(/^empresa/i),
    duimp: col(/^duimp/i),
    status: col(/^status/i),
    nf: col(/^nf/i),
    valor: col(/^valor/i),
    falta: col(/falta/i),
    mudou: col(/mudan/i),
    etapas: [1, 2, 3, 4, 5, 6].map((n) => col(new RegExp(`^${n}\\s*·`))),
  };
  const at = (r: unknown[], i: number) => (i >= 0 ? cell(r[i]) : null);
  const notes: FiscalNote[] = grid
    .slice(hi + 1)
    .filter((r) => cell(r[0]))
    .map((r) => ({
      processo: cell(r[0])!,
      empresa: at(r, C.empresa),
      duimp: at(r, C.duimp),
      status: at(r, C.status),
      etapas: C.etapas.map((i) => at(r, i) ?? ""),
      nf: at(r, C.nf),
      valor: at(r, C.valor),
      falta: at(r, C.falta),
      mudou: at(r, C.mudou),
    }));
  const history = histTab ? parseFiscalHistory(grids[histTab] ?? []) : [];

  // Embarques: cada pedaço da Ref Trading / BL vira uma chave; a NF também.
  const ships = await all<{ pi_number: string; ref_bl: string | null; nf: string | null }>(
    db,
    `SELECT pi_number, ref_bl, nf FROM shipments WHERE removed_at IS NULL AND (ref_bl IS NOT NULL OR nf IS NOT NULL)`,
  );
  const live = new Set((await all<{ pi_number: string }>(db, `SELECT pi_number FROM shipments WHERE removed_at IS NULL`)).map((r) => r.pi_number));
  const byRef = new Map<string, Set<string>>();
  const byNf = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, pi: string) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(pi);
  };
  for (const s of ships) {
    if (s.ref_bl) for (const t of [s.ref_bl, ...s.ref_bl.split(/[\s,;|]+/)]) add(byRef, alnum(t), s.pi_number);
    for (const t of String(s.nf ?? "").split(/[\s,;/|]+/)) add(byNf, digits(t), s.pi_number);
  }

  const por: Record<string, number> = {};
  const rows: { processo: string; data: string; pis: string; via: string | null }[] = [];
  const sem: string[] = [];
  const allPis = new Set<string>();
  for (const n of notes) {
    const key = alnum(fiscalKey(n.processo));
    // Às vezes o Processo é o assunto do e-mail ("RE NOVO EMBARQUE BBI25286.2 …", "… CMI26000800 REF I-MAR-1673-26 …"):
    // a PI escrita liga direto, e os códigos de trading viram apelidos.
    const text = n.processo.toUpperCase();
    const piHits = [...text.matchAll(/\b((?:GOC|BBI)\d{5})\.(\d+)\b/g)].map((m) => `${m[1]}-${m[2]}`).filter((p) => live.has(p));
    const codeHits = [...text.matchAll(/\b(CMI\d{6,}|I-MAR-\d{3,4}-\d{2}|WMFI[AM]\d{6,}|IMFOR\d+\/\d{2}|IMP-\d{2}\/\d+)/g)].map((m) => alnum(m[1]));
    // O Histórico traz os dois códigos da mesma nota (ex.: WMFIA262178 / WMFIMP-26/2192): viram apelidos.
    const hist = history.filter((h) => h.refs.some((r) => alnum(r) === key || codeHits.includes(alnum(r))) || (!!n.duimp && h.duimp === n.duimp));
    const aliases = new Set([key, ...codeHits, ...hist.flatMap((h) => h.refs.map(alnum))]);
    const nfs = new Set([digits(n.nf), ...hist.map((h) => digits(h.nf))].filter(Boolean));
    let via: string | null = null;
    const pis = new Set<string>();
    for (const p of byRef.get(key) ?? []) pis.add(p);
    if (pis.size) via = "ref";
    if (!pis.size && piHits.length) {
      for (const p of piHits) pis.add(p);
      via = "pi";
    }
    if (!pis.size) {
      for (const a of aliases) for (const p of byRef.get(a) ?? []) pis.add(p);
      if (pis.size) via = "historico";
    }
    if (!pis.size) {
      for (const f of nfs) for (const p of byNf.get(f) ?? []) pis.add(p);
      if (pis.size) via = "nf";
    }
    if (via) por[via] = (por[via] ?? 0) + 1;
    else sem.push(`${fiscalKey(n.processo)}${n.empresa ? ` (${n.empresa})` : ""}`);
    for (const p of pis) allPis.add(p);
    rows.push({
      processo: n.processo,
      data: JSON.stringify({ ...n, key: fiscalKey(n.processo), aliases: [...aliases], nfs: [...nfs] }),
      pis: JSON.stringify([...pis].sort()),
      via,
    });
  }

  const now = nowIso();
  await run(db, `DELETE FROM fiscal_notes`);
  for (const r of rows) {
    await run(db, `INSERT OR REPLACE INTO fiscal_notes (processo, data, pis, via, updated_at) VALUES (?, ?, ?, ?, ?)`, [r.processo, r.data, r.pis, r.via, now]);
  }
  const avisos = await notifyFiscalChanges(
    db,
    rows.map((r) => ({ view: fiscalNoteView(r.data, r.via, now), pis: JSON.parse(r.pis) as string[] })),
  );
  const prices = priceTab ? Math.max(0, (grids[priceTab] ?? []).length - 2) : 0;
  const result: FiscalRun = {
    avisos,
    processos: notes.length,
    ligados: notes.length - sem.length,
    por,
    pis: allPis.size,
    historico: history.length,
    precos_fci: prices,
    sem_vinculo: sem.slice(0, 40),
  };
  await run(db, `INSERT INTO settings (key, value) VALUES ('fiscal_notes_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ ...result, at: now })]);
  return result;
}
