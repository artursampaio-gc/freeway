import { buildPalette, loadPalette, type Palette, paletteSwatch } from "./colors";
import { galeriaByItem } from "./galeria";
import type { DB, Env } from "../env";
import { all, nowIso, one, run, todayBR, upsertJson } from "../db/q";
import { boardColumns, itemsWithSubitems, mondayConfigured, mondayQuery } from "../integrations/monday";
import { chatJson } from "../integrations/aiproxy";
import { accessToken, fetchRanges } from "../sheet/google";
import { readXlsx, type Grid } from "../sheet/xlsx";
import { fmtDate, fmtQty } from "../shared/labels";
import type { DevInfoView, DevLink, DevProjectView, DevSheet, DevTask, Health, SkuListView, SkuRow, StepStatus, StepView } from "../shared/types";
import { STEP_BY_KEY } from "./steps";
import { deliver, type NotificationSpec } from "./notify";
import { dueText, step, trackingDelivered, trackingText, withDue } from "./stepkit";

// Trilha de desenvolvimento do produto: lançamentos dos quadros "Launches" do Monday (um item por
// lançamento, com as tarefas nos subelementos), planilhas de Waitlist/CTR e a lista de SKUs.
// O lançamento liga ao pedido pela coluna "Process" (código do pedido, preenchido quando sai o PO).

export const DEV_KEYS = ["ctr", "waitlist", "cores", "amostra_fab", "amostra", "amostra_validacao", "goproduct", "documentacao"] as const;

/** Planilhas de Waitlist/CTR (dono: João Carlos), compartilhadas com a conta de serviço em 11/11/2026. */
const WAITLIST_PLAN_SHEET = "1MJaOstk3wkyxTIV4EM2J-Quwnxtt74rfyyhtW2jKhP8";
const WAITLIST_DATA_SHEET = "1w_9faPGTnadObygRDvXqF47PD9CWdtMsPzDKTS0ov6s";
const PEOPLE_TTL_MS = 24 * 3600 * 1000;

// ---------- Leitura de configurações ----------

async function getSetting<T>(db: DB, key: string): Promise<T | null> {
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, [key]);
  return row ? (JSON.parse(row.value) as T) : null;
}

async function setSetting(db: DB, key: string, value: unknown): Promise<void> {
  await run(db, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(value)]);
}

/** Quadros Launches entre os quadros escolhidos do Monday (Launches 2026, 2027…). */
export async function launchBoards(db: DB): Promise<{ id: string; name: string }[]> {
  const sel = (await getSetting<{ id: string; name: string }[]>(db, "monday_boards")) ?? [];
  return sel.filter((b) => /launch/i.test(b.name));
}

// ---------- Tarefas (subelementos) ----------

const TASK_STEPS: [string, RegExp][] = [
  ["ctr", /\bctr\b/i],
  ["waitlist", /^\s*wait\s*list/i],
  ["cores", /defini[çc][ãa]o (de|das) cores|aprova[çc][ãa]o (de|das) cores/i],
  ["amostra_validacao", /valida[çc][ãa]o (da |de |do )?amostra|aprova[çc][ãa]o (da |das |de )?amostras?/i],
  ["amostra", /envio (da|de) amostra/i],
  ["amostra_fab", /amostra|coment[áa]rios de melhoria/i],
  ["goproduct", /goproduct|^cadastro/i],
  ["documentacao", /pedido de compra|documenta[çc][ãa]o|carton|barcode|embalage/i],
];
/** Tarefas depois da documentação (produção, importação…) ou de outras trilhas: ficam fora da trilha. */
const AFTER = /produ[çc][ãa]o em massa|marketing|inspe[çc][ãa]o|importa[çc][ãa]o|desembara|itapeva|lan[çc]amento|pagamento do sinal|mockup|m[áa]scara|^grid|nome d|proje[çc][ãa]o|matriz/i;

// Etapa do Monday (Current Stage) em que cada passo da trilha acontece.
const STEP_STAGE: Record<string, number> = { ctr: 1, waitlist: 1, cores: 1, amostra_fab: 2, amostra: 2, amostra_validacao: 3, goproduct: 4, documentacao: 4 };

export function stageNumber(stage: string | null | undefined): number | null {
  if (!stage) return null;
  if (/launched/i.test(stage)) return 7;
  if (/not started/i.test(stage)) return 0;
  const m = stage.match(/stage\s*(\d)/i);
  return m ? Number(m[1]) : null;
}

function taskState(status: string | null, due: string | null, today: string): DevTask["state"] {
  const s = (status ?? "").toLowerCase();
  if (/n[ãa]o aprovad|reprovad/.test(s)) return "blocked";
  if (/pronto|feito|conclu|aprovado/.test(s)) return "done";
  if (/n[ãa]o necess|cancelad/.test(s)) return "na";
  if (/atrasad/.test(s)) return "late";
  const doing = /progresso|andamento|desenvolvimento/.test(s);
  if (due && due < today) return "late";
  return doing ? "doing" : "todo";
}

const isoDate = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

/** Uma tarefa a partir das colunas do subelemento (os títulos mudam entre os quadros de 2026 e 2027). */
export function toTask(name: string, vals: Record<string, string>, today: string): DevTask {
  const get = (re: RegExp) => Object.entries(vals).find(([k, v]) => re.test(k) && v)?.[1] ?? null;
  const status = get(/^status$/i);
  const timeline = get(/prazo|data de entrega|timeline/i);
  const [start, end] = timeline ? timeline.split(/\s+-\s+/) : [null, null];
  const due = isoDate(end ?? start);
  return {
    name: name.trim(),
    status,
    state: taskState(status, due, today),
    owner: get(/^(dono|owner|respons)/i),
    start: isoDate(start),
    due,
    done_at: isoDate(get(/conclus/i)),
  };
}

export function taskStep(name: string): string | null {
  for (const [key, re] of TASK_STEPS) if (re.test(name)) return AFTER.test(name) && key !== "documentacao" ? null : key;
  return null;
}

// ---------- Nomes (Monday × planilhas) ----------

const STOP = new Set(["de", "da", "do", "das", "dos", "e", "com", "br", "a", "o"]);

export function nameWords(s: string): string[] {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Casa o nome do lançamento com o produto de uma planilha (palavras em comum, exige 75%). */
export function bestMatch<T extends { produto: string }>(name: string, rows: T[]): T | null {
  const a = new Set(nameWords(name));
  let best: T | null = null;
  let score = 0;
  for (const r of rows) {
    const b = new Set(nameWords(r.produto));
    if (!a.size || !b.size) continue;
    const common = [...a].filter((w) => b.has(w)).length;
    const sc = common / Math.max(a.size, b.size);
    if (sc > score || (sc === score && best && r.produto.length > best.produto.length)) {
      score = sc;
      best = r;
    }
  }
  return score >= 0.75 ? best : null;
}

// ---------- Planilhas de Waitlist/CTR ----------

const serialToIso = (v: unknown): string | null => {
  if (typeof v === "number" && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  return isoDate(typeof v === "string" ? v : null);
};
const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function headerIndex(g: Grid, re: RegExp): number {
  return g.findIndex((row) => row.some((c) => re.test(txt(c))));
}

interface LinkCell {
  text: string;
  link: string | null;
}

/** Valores com o link de cada célula ("Link", "Link - LP" são links clicáveis na planilha). */
async function gridWithLinks(env: Env, sheetId: string, range: string): Promise<LinkCell[][]> {
  const auth = await accessToken(env);
  const fields = "sheets(data(rowData(values(formattedValue,hyperlink,textFormatRuns(format(link(uri)))))))";
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  const rows: any[] = json.sheets?.[0]?.data?.[0]?.rowData ?? [];
  return rows.map((r) =>
    (r.values ?? []).map((v: any) => ({
      text: txt(v.formattedValue),
      link: v.hyperlink ?? (v.textFormatRuns ?? []).find((t: any) => t.format?.link?.uri)?.format.link.uri ?? null,
    })),
  );
}

const titleCase = (h: string) => h.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace(/\bLp\b/, "LP").replace(/\bCtr\b/, "CTR");

export interface TrackingRow {
  produto: string;
  status: string | null;
  testes: string[];
  links: DevLink[];
}

/** Linhas de uma aba do acompanhamento (WAITLIST ou CTR): status, nomes dos testes e links por coluna. */
export function trackingRows(g: LinkCell[][]): TrackingRow[] {
  const h = g.findIndex((row) => row.some((c) => /^produto$/i.test(c.text)));
  if (h < 0) return [];
  const head = g[h].map((c) => c.text);
  const ip = head.findIndex((x) => /^produto$/i.test(x));
  const is = head.findIndex((x) => /^status$/i.test(x));
  const out: TrackingRow[] = [];
  for (const row of g.slice(h + 1)) {
    const produto = row[ip]?.text ?? "";
    if (!produto) continue;
    const links: DevLink[] = [];
    const testes: string[] = [];
    head.forEach((col, i) => {
      if (i === ip || i === is || /^imagem$/i.test(col)) return;
      const c = row[i];
      if (!c || (!c.text && !c.link)) return;
      const url = c.link ?? (/^https?:\/\//.test(c.text) ? c.text : null);
      const named = c.text && !/^link/i.test(c.text) && !/^https?:/.test(c.text);
      if (url) links.push({ label: named ? `${titleCase(col)}: ${c.text}` : `${titleCase(col)}${/lp/i.test(c.text) && !/landing/i.test(col) ? " (LP)" : ""}`, url });
      if (/^ctr/i.test(col) && named) testes.push(c.text);
    });
    out.push({ produto, status: row[is]?.text || null, testes, links });
  }
  return out;
}

const TEST_NOISE = new Set(["ctr", "admaker", "manual", "teste", "test", "video", "videos", "novo", "nova", "novos", "paineis", "imagem", "img", "estatico", "carrossel"]);
const PRODUCT_GENERIC = new Set(["novas", "nova", "cores", "cor", "drop", "facelift", "personalizada", "edicao", "especial", "vistas", "basic"]);
const plainWords = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

/** Testes de CTR com todas as palavras do produto no nome (pelo menos duas palavras, para não casar à toa). */
export function matchTests<T extends { teste: string }>(name: string, tests: T[]): T[] {
  const want = nameWords(name).filter((w) => !PRODUCT_GENERIC.has(w));
  if (want.length < 2) return [];
  return tests.filter((t) => {
    const have = new Set(plainWords(t.teste).filter((w) => !TEST_NOISE.has(w)));
    return want.every((w) => have.has(w));
  });
}

export interface SheetData {
  plan: TrackingRow[];
  ctr: TrackingRow[];
  status: NonNullable<DevSheet["status"]>[];
  result: NonNullable<DevSheet["result"]>[];
  votes: NonNullable<DevSheet["votes"]>[];
  tests: DevSheet["tests"];
}

/** Soma da aba BD (um dia de campanha por linha) por produto. */
export function waitlistResults(g: Grid): SheetData["result"] {
  const h = headerIndex(g, /^produto$/i);
  if (h < 0) return [];
  const head = g[h].map((c) => txt(c).toLowerCase());
  const col = (re: RegExp) => head.findIndex((x) => re.test(x));
  const [ip, id, ictr, ic, il, ik, ipr] = [col(/^produto$/), col(/^dia$/), col(/^ctr$/), col(/^custo$/), col(/^lead$/), col(/cliques/), col(/^pre[çc]o$/)];
  const by = new Map<string, { dias: Set<number>; inv: number; leads: number; cliques: number; ctrs: number[]; preco: number | null; last: number }>();
  for (const row of g.slice(h + 1)) {
    const p = txt(row[ip]);
    if (!p) continue;
    const a = by.get(p) ?? { dias: new Set<number>(), inv: 0, leads: 0, cliques: 0, ctrs: [], preco: null, last: 0 };
    const dia = num(row[id]);
    if (dia) {
      a.dias.add(dia);
      a.last = Math.max(a.last, dia);
    }
    a.inv += num(row[ic]) ?? 0;
    a.leads += num(row[il]) ?? 0;
    a.cliques += num(row[ik]) ?? 0;
    const c = num(row[ictr]);
    if (c !== null) a.ctrs.push(c);
    a.preco = num(row[ipr]) ?? a.preco;
    by.set(p, a);
  }
  return [...by].map(([produto, a]) => ({
    produto,
    dias: a.dias.size,
    investimento: Math.round(a.inv * 100) / 100,
    leads: a.leads,
    cliques: a.cliques,
    ctr: a.ctrs.length ? a.ctrs.reduce((x, y) => x + y, 0) / a.ctrs.length : null,
    custo_lead: a.leads ? a.inv / a.leads : null,
    lead_click: a.cliques ? a.leads / a.cliques : null,
    preco: a.preco,
    ultimo_dia: a.last ? serialToIso(a.last) : null,
  }));
}

/** Inscrições por cor: landing page (produto, cor) e Shopify (título "Produto - Cor" e o teste, colunas B e G). */
export function colorVotes(lp: Grid, shop: Grid): SheetData["votes"] {
  const by = new Map<string, Map<string, number>>();
  const add = (produto: string, cor: string) => {
    if (!produto || !cor) return;
    const m = by.get(produto) ?? new Map<string, number>();
    const k = cor.charAt(0).toUpperCase() + cor.slice(1);
    m.set(k, (m.get(k) ?? 0) + 1);
    by.set(produto, m);
  };
  for (const row of lp.slice(1)) {
    const cor = txt(row[1]);
    let produto = txt(row[0]);
    // "Charms Beauty Beats - Laranja" com cor "laranja": o produto é o que vem antes.
    const suffix = produto.match(/\s+-\s+([^-]+)$/);
    if (suffix && suffix[1].trim().toLowerCase() === cor.toLowerCase()) produto = produto.slice(0, suffix.index).trim();
    if (!/^teste\b/i.test(produto)) add(produto, cor);
  }
  for (const row of shop.slice(1)) {
    const title = txt(row[0]);
    const test = txt(row[5]);
    const cut = title.lastIndexOf(" - ");
    if (test && cut > 0) add(test, title.slice(cut + 3).trim());
  }
  return [...by].map(([produto, m]) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const cores = [...m].sort((a, b) => b[1] - a[1]).map(([cor, n]) => ({ cor, n, pct: Math.round((n / total) * 1000) / 10 }));
    return { produto, total, cores: cores.slice(0, 12) };
  });
}

/** Testes de CTR de 2026 (aba Testes CTR) e de 2025 (aba CTR -2025). */
export function ctrTests(t26: Grid, t25: Grid): DevSheet["tests"] {
  const out: DevSheet["tests"] = [];
  const h = headerIndex(t26, /^teste$/i);
  if (h >= 0) {
    const head = t26[h].map((c) => txt(c).toLowerCase());
    const col = (re: RegExp) => head.findIndex((x) => re.test(x));
    const [it, ii, ic, ip, ik, idt, is] = [col(/^teste$/), col(/investimento/), col(/^ctr/), col(/^cpc/), col(/cliques/), col(/data/), col(/^status/)];
    for (const row of t26.slice(h + 1)) {
      const teste = txt(row[it]);
      if (teste) out.push({ teste, investimento: num(row[ii]), ctr: num(row[ic]), cpc: num(row[ip]), cliques: num(row[ik]), status: txt(row[is]) || null, data: serialToIso(row[idt]) });
    }
  }
  const h2 = headerIndex(t25, /nome do conjunto/i);
  if (h2 >= 0) {
    const head = t25[h2].map((c) => txt(c).toLowerCase());
    const col = (re: RegExp) => head.findIndex((x) => re.test(x));
    const [it, ii, ic, ip, ik, idt, is] = [col(/nome do conjunto/), col(/valor usado/), col(/^ctr \(taxa de cliques no link/), col(/^cpc \(custo por clique no link/), col(/^cliques no link/), col(/data de cria/), col(/veicula/)];
    for (const row of t25.slice(h2 + 1)) {
      const teste = txt(row[it]);
      if (teste) out.push({ teste, investimento: num(row[ii]), ctr: num(row[ic]), cpc: num(row[ip]), cliques: num(row[ik]), status: txt(row[is]) || null, data: serialToIso(row[idt]) });
    }
  }
  return out;
}

/** Lê as planilhas de Waitlist/CTR e casa com cada lançamento dos quadros Launches (de hora em hora). */
export async function refreshWaitlist(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY)) return { skipped: "conta de serviço não configurada" };
  const [planW, planC, data] = await Promise.all([
    gridWithLinks(env, WAITLIST_PLAN_SHEET, "'WAITLIST'!A1:J1500"),
    gridWithLinks(env, WAITLIST_PLAN_SHEET, "'CTR'!A1:F1500"),
    // Lead Shopfy só de B a G (título, ids, preço, data e teste): o e-mail da coluna A não é lido.
    fetchRanges(env, WAITLIST_DATA_SHEET, ["'Status'!A1:I1500", "'BD'!A1:K15000", "'Leads - LP Vercel'!C1:D8000", "'Lead Shopfy'!B1:G9000", "'Testes CTR'!A1:J2000", "'CTR -2025'!A1:AA2000"]),
  ]);
  const st = data["Status"] ?? [];
  const status: SheetData["status"] = [];
  const hs = headerIndex(st, /^produto$/i);
  if (hs >= 0) {
    const head = st[hs].map((x) => txt(x).toLowerCase());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const [ip, ii, it, id, is, ica, imc] = [col(/^produto$/), col(/in[íi]cio/), col(/t[ée]rmino/), col(/^dias$/), col(/^status$/), col(/cor atual/), col(/melhor cor/)];
    for (const row of st.slice(hs + 1)) {
      const produto = txt(row[ip]);
      if (!produto || /^leads? -/i.test(produto)) continue;
      status.push({ produto, status: txt(row[is]) || null, dias: num(row[id]), inicio: serialToIso(row[ii]), fim: serialToIso(row[it]), cor_atual: txt(row[ica]) || null, melhor_cor: txt(row[imc]) || null });
    }
  }
  return saveSheetMatches(db, {
    plan: trackingRows(planW),
    ctr: trackingRows(planC),
    status,
    result: waitlistResults(data["BD"] ?? []),
    votes: colorVotes(data["Leads - LP Vercel"] ?? [], data["Lead Shopfy"] ?? []),
    tests: ctrTests(data["Testes CTR"] ?? [], data["CTR -2025"] ?? []),
  });
}

/** Casa as planilhas com os lançamentos e guarda por item do Monday. */
export async function saveSheetMatches(db: DB, sh: SheetData): Promise<Record<string, unknown>> {
  const boards = await launchBoards(db);
  const items = boards.length
    ? await all<{ item_id: string; name: string }>(db, `SELECT item_id, name FROM monday_items WHERE board_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(boards.map((b) => b.id))])
    : [];
  const now = nowIso();
  const rows: Record<string, unknown>[] = [];
  for (const it of items) {
    const plan = bestMatch(it.name, sh.plan);
    const ctr = bestMatch(it.name, sh.ctr);
    const m: DevSheet = {
      plan: plan ? { produto: plan.produto, status: plan.status, links: plan.links } : null,
      ctr: ctr ? { produto: ctr.produto, status: ctr.status, testes: ctr.testes, links: ctr.links } : null,
      status: bestMatch(it.name, sh.status),
      result: bestMatch(it.name, sh.result),
      votes: bestMatch(it.name, sh.votes),
      tests: matchTests(it.name, sh.tests).sort((a, b) => (b.data ?? "").localeCompare(a.data ?? "")).slice(0, 8),
    };
    if (m.plan || m.ctr || m.status || m.result || m.votes || m.tests.length) rows.push({ item_id: it.item_id, data: JSON.stringify(m), updated_at: now });
  }
  await run(db, `DELETE FROM dev_sheet_match`);
  if (rows.length) await upsertJson(db, "dev_sheet_match", ["item_id", "data", "updated_at"], ["item_id"], rows);
  return { lancamentos: items.length, casados: rows.length, waitlist: sh.plan.length, ctr: sh.ctr.length, resultados: sh.result.length, votos: sh.votes.length, testes: sh.tests.length };
}

// ---------- Monday: tarefas e pessoas ----------

function itemActive(group: string | null, vals: Record<string, string>): boolean {
  if (/cancelad/i.test(group ?? "")) return false;
  if (/cancel/i.test(vals["Launch status"] ?? "")) return false;
  return !/launched/i.test(vals["Current Stage"] ?? "");
}

/** Lê os subelementos (tarefas) dos lançamentos ainda abertos nos quadros Launches. */
export async function syncLaunchTasks(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!mondayConfigured(env)) return { skipped: "MONDAY_TOKEN não configurado" };
  const boards = await launchBoards(db);
  if (!boards.length) return { skipped: "nenhum quadro Launches escolhido" };
  const items = await all<{ item_id: string; group_title: string | null; vals: string }>(
    db,
    `SELECT item_id, group_title, vals FROM monday_items WHERE board_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(boards.map((b) => b.id))],
  );
  const active = items.filter((i) => itemActive(i.group_title, JSON.parse(i.vals ?? "{}"))).map((i) => i.item_id);
  if (!active.length) return { items: 0, tasks: 0 };
  const raw = await itemsWithSubitems(env, active);
  // Títulos das colunas de cada quadro de subelementos (guardados; relidos quando aparece um quadro novo).
  const titles = (await getSetting<Record<string, Record<string, string>>>(db, "monday_sub_columns")) ?? {};
  const subBoards = [...new Set(raw.flatMap((r) => r.subitems.map((s) => s.board_id)).filter(Boolean) as string[])];
  const missing = subBoards.filter((b) => !titles[b]);
  if (missing.length) {
    for (const b of await boardColumns(env, missing)) titles[b.id] = Object.fromEntries(b.columns.map((c) => [c.id, c.title]));
    await setSetting(db, "monday_sub_columns", titles);
  }
  const rows: Record<string, unknown>[] = [];
  for (const r of raw) {
    r.subitems.forEach((s, pos) => {
      const t = titles[s.board_id ?? ""] ?? {};
      const vals: Record<string, string> = {};
      for (const v of s.values) if (v.text) vals[t[v.id] ?? v.id] = v.text;
      rows.push({ subitem_id: s.id, parent_id: r.id, board_id: s.board_id, pos, name: s.name, vals: JSON.stringify(vals), updated_at: nowIso() });
    });
  }
  await run(db, `DELETE FROM monday_subitems WHERE parent_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(raw.map((r) => r.id))]);
  if (rows.length) await upsertJson(db, "monday_subitems", ["subitem_id", "parent_id", "board_id", "pos", "name", "vals", "updated_at"], ["subitem_id"], rows);
  return { items: raw.length, tasks: rows.length };
}

/** Nome → e-mail das pessoas do Monday (a coluna People mostra o nome). */
export async function syncMondayPeople(db: DB, env: Env, force = false): Promise<number> {
  if (!mondayConfigured(env)) return 0;
  const saved = await getSetting<{ at: string; map: Record<string, string> }>(db, "monday_people");
  if (!force && saved && Date.now() - Date.parse(saved.at) < PEOPLE_TTL_MS) return Object.keys(saved.map).length;
  const data = await mondayQuery<{ users: { name: string; email: string }[] }>(env, `query { users(limit: 1000) { name email } }`);
  const map = Object.fromEntries((data.users ?? []).filter((u) => u.email).map((u) => [u.name.trim().toLowerCase(), u.email.trim().toLowerCase()]));
  await setSetting(db, "monday_people", { at: nowIso(), map });
  return Object.keys(map).length;
}

// ---------- Lançamentos ----------

function splitPeople(text: string | undefined): string[] {
  return (text ?? "").split(/,\s*/).map((s) => s.trim()).filter(Boolean);
}

interface ItemRow {
  item_id: string;
  board_id: string;
  name: string;
  group_title: string | null;
  url: string | null;
  vals: string;
  process_codes: string;
  updated_at: string | null;
}

/** Monta os lançamentos com tarefas, pessoas e o que as planilhas de Waitlist/CTR dizem do produto. */
export async function devInfos(db: DB, rows: ItemRow[], today = todayBR()): Promise<DevInfoView[]> {
  if (!rows.length) return [];
  const [subs, people, wl, boards] = await Promise.all([
    all<{ parent_id: string; name: string; vals: string }>(db, `SELECT parent_id, name, vals FROM monday_subitems WHERE parent_id IN (SELECT value FROM json_each(?)) ORDER BY parent_id, pos`, [JSON.stringify(rows.map((r) => r.item_id))]),
    getSetting<{ map: Record<string, string> }>(db, "monday_people"),
    all<{ item_id: string; data: string }>(db, `SELECT item_id, data FROM dev_sheet_match WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(rows.map((r) => r.item_id))]),
    launchBoards(db),
  ]);
  const sheetBy = new Map(wl.map((w) => [w.item_id, JSON.parse(w.data) as DevSheet]));
  const boardName = new Map(boards.map((b) => [b.id, b.name.replace(/[^\p{L}\p{N} ]/gu, "").trim()]));
  const tasksBy = new Map<string, DevTask[]>();
  for (const s of subs) tasksBy.set(s.parent_id, [...(tasksBy.get(s.parent_id) ?? []), toTask(s.name, JSON.parse(s.vals ?? "{}"), today)]);
  return rows.map((r) => {
    const v = JSON.parse(r.vals ?? "{}") as Record<string, string>;
    const names = splitPeople(v["People"]);
    const emails = names.map((n) => (n.includes("@") ? n.toLowerCase() : people?.map[n.toLowerCase()] ?? null)).filter(Boolean) as string[];
    const tasks: Record<string, DevTask[]> = {};
    const other: DevTask[] = [];
    for (const t of tasksBy.get(r.item_id) ?? []) {
      const k = taskStep(t.name);
      if (k) (tasks[k] ??= []).push(t);
      else if (!AFTER.test(t.name)) other.push(t);
    }
    return {
      item_id: r.item_id,
      name: r.name.replace(/^[^\p{L}\p{N}[]+/u, "").trim(),
      url: r.url,
      board: boardName.get(r.board_id) ?? r.board_id,
      launch_group: r.group_title,
      people: names,
      emails: [...new Set(emails)],
      stage: v["Current Stage"] ?? null,
      launch_status: v["Launch status"] ?? null,
      sub_stage: v["Sub-stage"] ?? null,
      tipo: v["Tipo"] ?? null,
      waitlist_col: v["Waitlist"] ?? null,
      process_codes: JSON.parse(r.process_codes ?? "[]"),
      tasks,
      other_tasks: other,
      sheet: sheetBy.get(r.item_id) ?? null,
    };
  });
}

const ITEM_COLS = `m.item_id, m.board_id, m.name, m.group_title, m.url, m.vals, m.process_codes, m.updated_at`;

/** Lançamentos ligados aos pedidos (pela coluna Process), por código. Cancelados ficam de fora. */
export async function devInfosByCode(db: DB, codes: string[]): Promise<Map<string, DevInfoView[]>> {
  const out = new Map<string, DevInfoView[]>();
  const boards = await launchBoards(db);
  if (!codes.length || !boards.length) return out;
  const rows = await all<ItemRow>(
    db,
    `SELECT ${ITEM_COLS} FROM monday_items m
      WHERE m.board_id IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM json_each(m.process_codes) j WHERE j.value IN (SELECT value FROM json_each(?)))
      ORDER BY m.updated_at DESC`,
    [JSON.stringify(boards.map((b) => b.id)), JSON.stringify(codes)],
  );
  const live = rows.filter((r) => !/cancelad/i.test(r.group_title ?? "") && !/cancel/i.test(JSON.parse(r.vals ?? "{}")["Launch status"] ?? ""));
  for (const info of await devInfos(db, live)) {
    for (const c of info.process_codes) if (codes.includes(c)) out.set(c, [...(out.get(c) ?? []), info]);
  }
  return out;
}

/** Lançamentos abertos (todos, ou um só pelo item do Monday). */
/** Lançamentos abertos; um só (pelo item, mesmo encerrado) ou alguns (lista de itens, só os abertos). */
export async function openDevInfos(db: DB, itemId?: string | string[]): Promise<DevInfoView[]> {
  const boards = await launchBoards(db);
  if (!boards.length || (Array.isArray(itemId) && !itemId.length)) return [];
  const single = typeof itemId === "string";
  const filter = single ? "AND m.item_id = ?" : itemId ? "AND m.item_id IN (SELECT value FROM json_each(?))" : "";
  const rows = await all<ItemRow>(
    db,
    `SELECT ${ITEM_COLS} FROM monday_items m WHERE m.board_id IN (SELECT value FROM json_each(?)) ${filter} ORDER BY m.updated_at DESC`,
    [JSON.stringify(boards.map((b) => b.id)), ...(single ? [itemId] : itemId ? [JSON.stringify(itemId)] : [])],
  );
  return devInfos(db, single ? rows : rows.filter((r) => itemActive(r.group_title, JSON.parse(r.vals ?? "{}"))));
}

// ---------- Lista de SKUs ----------

export interface SkuDbRow {
  id: number;
  scope: string;
  code: string | null;
  name: string | null;
  qty: number | null;
  source: string;
}

const SOURCE_LABEL: Record<SkuListView["source"], string> = {
  po: "PO do FileMaker",
  planilha: "Planilha de importação (POs por Item)",
  lista: "Lista enviada · temporária até a PO",
  manual: "Informada à mão · temporária até a PO",
  vazia: "Sem lista de SKUs",
};

/**
 * Lista de SKUs do pedido ou do lançamento: a PO do FileMaker vale primeiro; depois os itens da
 * planilha de importação; sem nenhuma das duas, a lista temporária (à mão ou lida pela IA).
 */
export function buildSkuList(scope: string, rows: SkuDbRow[], planilha: { code: string | null; name: string | null; qty: number | null }[], gp: Map<string, GpHit>): SkuListView {
  const withGp = (r: { id?: number | null; code: string | null; name: string | null; qty: number | null }): SkuRow => {
    const hit = r.code ? gp.get(r.code.trim().toUpperCase()) : undefined;
    return { id: r.id ?? null, code: r.code, name: r.name, qty: r.qty, goproduct: !!hit, goproduct_pk: hit?.pk ?? null, color: hit?.cor ?? null, color_hex: hit?.cor_hex ?? null };
  };
  const po = rows.filter((r) => r.source === "po");
  if (po.length) return { scope, source: "po", source_label: SOURCE_LABEL.po, rows: po.map(withGp), editable: false };
  const sheet = planilha.filter((i) => i.code);
  if (sheet.length) return { scope, source: "planilha", source_label: SOURCE_LABEL.planilha, rows: sheet.map(withGp), editable: false };
  const temp = rows.filter((r) => r.source === "lista" || r.source === "manual");
  const source = !temp.length ? "vazia" : temp.some((r) => r.source === "lista") ? "lista" : "manual";
  return { scope, source, source_label: SOURCE_LABEL[source], rows: temp.map(withGp), editable: true };
}

export interface GpHit {
  pk: number;
  cor: string | null;
  cor_hex: string | null;
}

export async function goproductByCode(db: DB, codes: string[]): Promise<Map<string, GpHit>> {
  const list = [...new Set(codes.filter(Boolean).map((c) => c.trim().toUpperCase()))];
  if (!list.length) return new Map();
  const rows = await all<{ pk: number; ipn: string; cor: string | null; cor_hex: string | null }>(
    db,
    "SELECT pk, ipn, cor, cor_hex FROM goproduct_parts WHERE ipn IN (SELECT value FROM json_each(?)) ORDER BY pk",
    [JSON.stringify(list)],
  );
  const out = new Map<string, GpHit>();
  for (const r of rows) if (!out.has(r.ipn)) out.set(r.ipn, { pk: r.pk, cor: r.cor ?? null, cor_hex: r.cor_hex ?? null });
  return out;
}

export const validScope = (s: string) => /^(GOC|BBI)\d{5}$/.test(s) || /^dev:\d+$/.test(s);

const CODE_HEAD = /internal item|item number|^sku|c[óo]d|^ipn|refer[êe]ncia|^code/i;
const QTY_HEAD = /^qty|quant|^qtd/i;
const NAME_HEAD = /descri|^nome|^name|^produto|^product/i;
const COLOR_HEAD = /^colou?r|^cor\b/i;

/** Linhas de SKU de uma tabela com cabeçalho reconhecível (código e quantidade ou nome). Vazio se não reconhecer. */
export function parseSkuGrid(g: Grid): { code: string | null; name: string | null; qty: number | null }[] {
  const h = g.findIndex((row) => row.some((c) => CODE_HEAD.test(txt(c))) && row.some((c) => QTY_HEAD.test(txt(c)) || NAME_HEAD.test(txt(c))));
  if (h < 0) return [];
  const head = g[h].map(txt);
  const col = (re: RegExp) => head.findIndex((x) => re.test(x));
  const [ic, iq, inm, ico] = [col(CODE_HEAD), col(QTY_HEAD), col(NAME_HEAD), col(COLOR_HEAD)];
  const out: { code: string | null; name: string | null; qty: number | null }[] = [];
  let blanks = 0;
  for (const row of g.slice(h + 1)) {
    const code = txt(row[ic]).replace(/\s+/g, "");
    if (!code || /^total$/i.test(code)) {
      if (++blanks >= 2) break;
      continue;
    }
    blanks = 0;
    const color = ico >= 0 ? txt(row[ico]).split(/[█\n]/)[0].trim() : "";
    const name = [inm >= 0 ? txt(row[inm]) : "", color].filter(Boolean).join(" · ") || null;
    const q = iq >= 0 ? Number(String(row[iq] ?? "").replace(/[^\d.,-]/g, "").replace(",", ".")) : NaN;
    out.push({ code: code.toUpperCase(), name, qty: Number.isFinite(q) && q > 0 ? q : null });
  }
  return out;
}

function textGrid(text: string): Grid {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.some((l) => l.includes(";")) ? ";" : ",";
  return lines.map((l) => l.split(sep).map((c) => c.trim()));
}

/**
 * Lê uma lista de SKUs enviada (planilha .xlsx/.csv, texto colado ou foto): primeiro pelo cabeçalho;
 * sem cabeçalho reconhecível, a IA monta a lista. Substitui a lista anterior lida desta forma.
 */
export async function importSkuList(
  db: DB, env: Env, scope: string, input: { text?: string; file_b64?: string; filename?: string; mime?: string }, user: string,
): Promise<{ rows: number; via: "tabela" | "ia" }> {
  let grid: Grid = [];
  let image: string | null = null;
  if (input.file_b64) {
    const bytes = Uint8Array.from(atob(input.file_b64), (c) => c.charCodeAt(0));
    const name = (input.filename ?? "").toLowerCase();
    if (name.endsWith(".xlsx")) {
      const book = await readXlsx(bytes);
      grid = Object.values(book).find((g) => g.some((r) => r.some((c) => txt(c)))) ?? [];
    } else if ((input.mime ?? "").startsWith("image/")) image = `data:${input.mime};base64,${input.file_b64}`;
    else grid = textGrid(new TextDecoder().decode(bytes));
  } else if (input.text) grid = textGrid(input.text);
  let rows = image ? [] : parseSkuGrid(grid);
  let via: "tabela" | "ia" = "tabela";
  if (!rows.length) {
    if (!env.AI_PROXY_TOKEN) throw new Error("Não reconheci as colunas (código e quantidade) e a IA não está configurada");
    const table = grid.slice(0, 400).map((r) => r.map(txt).join(" | ")).join("\n");
    const { data } = await chatJson(
      env,
      "Você lê listas de produtos de um pedido de importação e devolve só JSON no formato {\"itens\":[{\"codigo\":string|null,\"nome\":string|null,\"quantidade\":number|null}]}. " +
        "codigo é o SKU/código interno (ex.: GF702082, TX221004); não invente códigos nem itens; ignore totais, cabeçalhos e linhas vazias.",
      image ? "Leia a lista de SKUs desta imagem." : `Lista enviada:\n${table}`,
      image ? [image] : [],
    );
    rows = ((data?.itens ?? []) as any[])
      .map((i) => ({ code: i.codigo ? String(i.codigo).replace(/\s+/g, "").toUpperCase() : null, name: i.nome ? String(i.nome).slice(0, 200) : null, qty: Number(i.quantidade) > 0 ? Number(i.quantidade) : null }))
      .filter((i) => i.code || i.name);
    via = "ia";
  }
  if (!rows.length) throw new Error("Não encontrei SKUs na lista enviada");
  await run(db, `DELETE FROM sku_lists WHERE scope = ? AND source = 'lista'`, [scope]);
  const now = nowIso();
  for (const r of rows.slice(0, 500)) {
    await run(db, `INSERT INTO sku_lists (scope, code, name, qty, source, created_by, created_at) VALUES (?, ?, ?, ?, 'lista', ?, ?)`, [scope, r.code, r.name, r.qty, user, now]);
  }
  return { rows: Math.min(rows.length, 500), via };
}

// ---------- Etapas ----------

export interface DevInputs {
  info: DevInfoView | null;
  /** Registro da amostra no app (rastreio, entrega, aprovação). */
  amostra: Record<string, any>;
  /** Registro da produção no app (documentação: docs_done_at, docs_link). */
  producao: Record<string, any>;
  docsFolder: { name: string; link: string } | null;
  /** O pedido já embarcou (a documentação foi feita, mesmo sem registro). */
  shipped: boolean;
  /** A produção já começou (tudo antes dela já aconteceu). */
  started: boolean;
  hasCode: boolean;
  skus: SkuListView;
  /** Marcações no app das etapas do desenvolvimento (CTR, Waitlist, Cores, Fabricação). */
  manual?: Record<string, Record<string, any>>;
  /** Cores do GoProduct pelo nome, para o quadradinho das cores escritas na PO ou no app. */
  palette?: Palette;
  today: string;
}

const DONE_STATUS = new Set<StepStatus>(["done", "na"]);

/** Etapa pelas tarefas do Monday: concluída quando todas estão prontas; senão, a primeira em aberto. */
function fromTasks(key: string, tasks: DevTask[] | undefined, today: string): StepView | null {
  if (!tasks?.length) return null;
  const def = STEP_BY_KEY[key];
  const live = tasks.filter((t) => t.state !== "na");
  if (!live.length) return step(def, "na", 0, "Não necessário (Monday)", { source: "monday" });
  const done = live.filter((t) => t.state === "done");
  if (done.length === live.length) {
    const at = done.map((t) => t.done_at).filter(Boolean).sort().at(-1);
    return step(def, "done", 1, `${live.length > 1 ? `${live.length} tarefas prontas` : "Pronto"}${at ? ` em ${fmtDate(at, true)}` : ""} (Monday)`, { source: "monday" });
  }
  const open = live.filter((t) => t.state !== "done").sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const t = open[0];
  let status: StepStatus = open.some((x) => x.state === "blocked") ? "blocked" : open.some((x) => x.state === "late") ? "late" : open.some((x) => x.state === "doing") || done.length ? "doing" : "todo";
  status = withDue(status, t.due, today);
  const detail = [`${t.name}: ${t.status ?? "sem status"}`, t.owner, dueText(t.due, today)].filter(Boolean).join(" · ");
  return step(def, status, done.length / live.length * 0.9 + (status === "doing" ? 0.05 : 0), detail, { source: "monday", due: t.due });
}

/** Sem tarefa no Monday: pela etapa atual do lançamento (Current Stage). */
function fromStage(key: string, info: DevInfoView | null): StepView | null {
  const n = stageNumber(info?.stage);
  if (n === null || n === undefined) return null;
  const def = STEP_BY_KEY[key];
  const at = STEP_STAGE[key];
  if (n > at) return step(def, "done", 1, `Concluído pela etapa do Monday (${info!.stage})`, { source: "monday" });
  if (n === at) return step(def, "doing", 0.3, `Em andamento (Monday: ${info!.stage}${info!.sub_stage ? ` · ${info!.sub_stage}` : ""})`, { source: "monday" });
  return null;
}

function inferred(key: string): StepView {
  return step(STEP_BY_KEY[key], "done", 1, "Sem registro (a produção já começou)", { source: "inferido" });
}

function settle(key: string, x: DevInputs, own: StepView | null, fallback: StepView): StepView {
  const v = own ?? fromStage(key, x.info) ?? fallback;
  if (x.started && !DONE_STATUS.has(v.status)) return inferred(key);
  return v;
}

const pctTxt = (v: number | null | undefined) => (v === null || v === undefined ? "" : `${(v * 100).toFixed(1).replace(".", ",")}%`);
const brl = (v: number | null | undefined) => (v === null || v === undefined ? "" : `R$ ${v.toFixed(2).replace(".", ",")}`);

function ctrBase(x: DevInputs, sh: DevSheet | null | undefined): StepView {
  const def = STEP_BY_KEY.ctr;
  if (!x.info) return step(def, "na", 0, "Sem lançamento no Monday");
  const own = fromTasks("ctr", x.info.tasks.ctr, x.today);
  if (own) return settle("ctr", x, own, own);
  const col = (x.info.waitlist_col ?? "").toLowerCase();
  const sheet = sh?.ctr;
  const best = [...(sh?.tests ?? [])].filter((t) => t.ctr !== null).sort((a, b) => (b.ctr ?? 0) - (a.ctr ?? 0))[0];
  const tests = [sheet?.testes.length ? sheet.testes.slice(0, 3).join(" / ") : "", best ? `melhor teste: CTR ${pctTxt(best.ctr)}` : ""].filter(Boolean).map((t) => ` · ${t}`).join("");
  if (sheet && /aprov|conclu|finaliz|ok\b/i.test(sheet.status ?? "")) return step(def, "done", 1, `Teste de CTR: ${sheet.status}${tests}`, { source: "planilha" });
  if (sheet && /reprov/i.test(sheet.status ?? "")) return step(def, "blocked", 0.5, `Teste de CTR reprovado${tests}`, { source: "planilha" });
  if (/^ctr$/.test(col)) return step(def, "doing", 0.5, `Em teste de CTR (Monday)${tests}`, { source: "monday" });
  if (/feito|conclu|andamento|novo teste/.test(col)) return step(def, "done", 1, `CTR feito · waitlist ${x.info.waitlist_col!.toLowerCase()} (Monday)${tests}`, { source: "monday" });
  if (/n\/a|n[ãa]o realizado/.test(col)) return step(def, "na", 0, `Sem teste (Monday: ${x.info.waitlist_col})`, { source: "monday" });
  if (sheet || best) return settle("ctr", x, step(def, "doing", 0.4, `Teste na planilha${sheet?.status ? `: ${sheet.status}` : ""}${tests}`, { source: "planilha" }), step(def, "todo", 0, ""));
  return settle("ctr", x, null, step(def, "todo", 0, "Sem teste de CTR registrado"));
}

function ctrStep(x: DevInputs): StepView {
  const sh = x.info?.sheet;
  const v = ctrBase(x, sh);
  const links = [...(sh?.ctr?.links ?? []), ...(sh?.plan?.links ?? []).filter((l) => /^ctr/i.test(l.label))];
  return { ...v, data: { ...(v.data ?? {}), links, tests: sh?.tests ?? [] } };
}

function waitlistBase(x: DevInputs, sh: DevSheet | null | undefined): StepView {
  const def = STEP_BY_KEY.waitlist;
  if (!x.info) return step(def, "na", 0, "Sem lançamento no Monday");
  const r = sh?.result;
  const situation = sh?.plan?.status ?? sh?.status?.status ?? null;
  const extra = [situation && `planilha: ${situation.toLowerCase()}`, r ? `${r.dias} dias · ${fmtQty(r.leads)} leads · custo/lead ${brl(r.custo_lead)}` : null].filter(Boolean).join(" · ");
  const plus = (v: StepView) => (extra && !v.detail.includes(extra) ? { ...v, detail: [v.detail, extra].filter(Boolean).join(" · ") } : v);
  const own = fromTasks("waitlist", x.info.tasks.waitlist, x.today);
  if (own) return plus(settle("waitlist", x, own, own));
  const col = (x.info.waitlist_col ?? "").toLowerCase();
  if (/feito|conclu/.test(col)) return plus(step(def, "done", 1, "Waitlist concluída (Monday)", { source: "monday" }));
  if (/andamento|novo teste/.test(col)) return plus(step(def, "doing", 0.5, `Waitlist ${col} (Monday)`, { source: "monday" }));
  if (/n\/a|n[ãa]o realizado/.test(col)) return step(def, "na", 0, `Sem waitlist (Monday: ${x.info.waitlist_col})`, { source: "monday" });
  if (situation && /ativa|pausad|ajuste/i.test(situation)) return plus(step(def, "doing", 0.5, situation.charAt(0) + situation.slice(1).toLowerCase(), { source: "planilha" }));
  return plus(settle("waitlist", x, null, step(def, "todo", 0, x.info.waitlist_col ? `Monday: ${x.info.waitlist_col}` : "Sem waitlist registrada")));
}

function waitlistStep(x: DevInputs): StepView {
  const sh = x.info?.sheet;
  const v = waitlistBase(x, sh);
  const links = (sh?.plan?.links ?? []).filter((l) => !/^ctr/i.test(l.label));
  return { ...v, data: { ...(v.data ?? {}), links, result: sh?.result ?? null, situation: sh?.plan?.status ?? sh?.status?.status ?? null, votes: sh?.votes ?? null } };
}

/**
 * Cores do produto: as definidas no app, as do cadastro no GoProduct (pelos SKUs) ou as da PO, com o quadradinho
 * como no GoProduct: fracionado na cor composta (todos os pantones) e a miniatura da textura na estampa.
 */
function colorsOf(x: DevInputs): { name: string; hex: string | null; hexes: string[]; tex: string | null; source: string }[] {
  const pal = x.palette ?? buildPalette();
  return rawColors(x).map((c) => {
    const sw = paletteSwatch(c.name, pal);
    return { ...c, hex: c.hex ?? sw?.hex ?? null, hexes: sw?.hexes ?? [], tex: sw?.tex ?? null };
  });
}

function rawColors(x: DevInputs): { name: string; hex: string | null; source: string }[] {
  const manual = String(x.manual?.cores?.colors ?? "").split(/[,;\n]+/).map((c) => c.trim()).filter(Boolean);
  if (manual.length) return manual.map((name) => ({ name, hex: null, source: "app" }));
  const seen = new Map<string, { name: string; hex: string | null; source: string }>();
  for (const r of x.skus.rows) if (r.color && !seen.has(r.color.toLowerCase())) seen.set(r.color.toLowerCase(), { name: r.color, hex: r.color_hex, source: "GoProduct" });
  if (seen.size) return [...seen.values()];
  if (x.skus.source === "po") {
    for (const r of x.skus.rows) {
      const c = r.name?.split(" · ").at(-1)?.trim();
      if (c && r.name?.includes(" · ") && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), { name: c, hex: null, source: "PO" });
    }
  }
  return [...seen.values()];
}

function coresStep(x: DevInputs): StepView {
  const def = STEP_BY_KEY.cores;
  const colors = colorsOf(x);
  const votes = x.info?.sheet?.votes ?? null;
  // "color_list" (calculada) separada de "colors" (o texto digitado no app).
  const data = { color_list: colors, votes: votes ? votes.cores.slice(0, 8) : [], votes_total: votes?.total ?? 0 };
  const names = colors.length ? `${colors.map((c) => c.name).join(", ")} (${colors[0].source})` : "";
  if (!x.info) return step(def, colors.length ? "done" : "na", colors.length ? 1 : 0, names ? `Cores: ${names}` : "Sem lançamento no Monday", { data, source: colors.length ? "goproduct" : undefined });
  const v = settle("cores", x, fromTasks("cores", x.info.tasks.cores, x.today), step(def, "todo", 0, "Aguardando a definição das cores"));
  const top = !colors.length && votes?.cores.length ? `mais votadas na waitlist: ${votes.cores.slice(0, 3).map((c) => `${c.cor} ${String(c.pct).replace(".", ",")}%`).join(", ")}` : "";
  // Os votos aparecem no cartão; no texto, só quando não há cor definida (lista de lançamentos, "Agora").
  return { ...v, data: { ...(v.data ?? {}), ...data }, detail: [names ? `Cores: ${names}` : "", v.detail, v.status === "done" ? "" : top].filter(Boolean).join(" · ") };
}

/**
 * Marcações no app (CTR, Waitlist, Cores, Fabricação): concluído, não se aplica, prazo, link, observação e
 * "rodar de novo" (ex.: a waitlist precisa rodar outra vez), que reabre a etapa mesmo com o Monday dizendo pronto.
 */
export function applyManual(key: string, v: StepView, m: Record<string, any> | undefined, today: string): StepView {
  if (!m || !Object.keys(m).length) return v;
  const def = STEP_BY_KEY[key];
  const data = { ...(v.data ?? {}), ...m };
  const note = m.note ? ` · ${m.note}` : "";
  if (m.na) return step(def, "na", 0, `Não se aplica (marcado no app)${note}`, { data, source: "manual" });
  if (m.rerun_at && (!m.done_at || m.done_at < m.rerun_at)) {
    const round = m.rerun_count ? `${m.rerun_count + 1}ª rodada` : "Rodando de novo";
    return step(def, withDue("doing", m.due, today), 0.3, [`${round} desde ${fmtDate(m.rerun_at, true)}${note}`, dueText(m.due, today)].filter(Boolean).join(" · "), { data, source: "manual", due: m.due ?? null });
  }
  if (m.done_at) return step(def, "done", 1, `Concluído em ${fmtDate(m.done_at, true)} (app)${note}`, { data, source: "manual" });
  if (m.due && v.status !== "done" && v.status !== "na") {
    return { ...v, data, due: m.due, status: withDue(v.status, m.due, today), detail: [v.detail + note, dueText(m.due, today)].filter(Boolean).join(" · ") };
  }
  return { ...v, data, detail: v.detail + note };
}

const DEV_EDIT_FIELDS: Record<string, string[]> = {
  ctr: ["done_at", "na", "rerun_at", "due", "link", "note"],
  waitlist: ["done_at", "na", "rerun_at", "due", "link", "note"],
  cores: ["done_at", "na", "due", "link", "note", "colors"],
  amostra_fab: ["done_at", "na", "rerun_at", "due", "link", "note"],
};
export const DEV_EDITABLE = Object.keys(DEV_EDIT_FIELDS);
const DEV_DATE = new Set(["done_at", "rerun_at", "due"]);

/**
 * Grava a marcação no app de uma etapa do desenvolvimento. O lançamento guarda em "dev:<item>" (vale
 * antes e depois do pedido existir); sem lançamento, no próprio pedido. Registra na linha do tempo do pedido.
 */
export async function updateDevStep(db: DB, scope: string, key: string, patch: Record<string, unknown>, user: string): Promise<Record<string, any>> {
  const allowed = DEV_EDIT_FIELDS[key];
  if (!allowed || !validScope(scope)) throw new Error("Etapa inválida");
  const row = await one<{ data: string }>(db, `SELECT data FROM step_state WHERE scope = ? AND step_key = ?`, [scope, key]);
  const old: Record<string, any> = row ? JSON.parse(row.data) : {};
  const next: Record<string, any> = { ...old };
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    if (v === "" || v === undefined || v === null) next[k] = null;
    else if (DEV_DATE.has(k)) {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Data inválida em ${k}`);
      next[k] = v;
    } else if (k === "na") next[k] = !!v;
    else next[k] = String(v).trim().slice(0, 2000);
  }
  const def = STEP_BY_KEY[key];
  const msgs: string[] = [];
  if (next.rerun_at && next.rerun_at !== old.rerun_at) {
    next.rerun_count = (old.rerun_count ?? 0) + 1;
    next.done_at = null;
    msgs.push(`${def.label} vai rodar de novo (${next.rerun_count + 1}ª rodada)`);
  }
  if ((old.done_at ?? null) !== (next.done_at ?? null)) msgs.push(next.done_at ? `${def.label} concluído (marcado no app)` : `${def.label} reaberto`);
  if (!!old.na !== !!next.na) msgs.push(next.na ? `${def.label} marcado como não se aplica` : `${def.label} voltou a valer`);
  if ((old.colors ?? null) !== (next.colors ?? null) && next.colors) msgs.push(`Cores definidas: ${next.colors}`);
  if ((old.due ?? null) !== (next.due ?? null) && next.due) msgs.push(`${def.label}: prazo ${fmtDate(next.due)}`);
  if ((old.note ?? null) !== (next.note ?? null) && next.note) msgs.push(`${def.label}: ${next.note}`);
  next.updated_by = user;
  await run(
    db,
    `INSERT INTO step_state (scope, step_key, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, step_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [scope, key, JSON.stringify(next), nowIso(), user],
  );
  // Linha do tempo: no pedido, ou nos pedidos ligados ao lançamento.
  let codes: string[] = scope.startsWith("dev:") ? [] : [scope];
  if (scope.startsWith("dev:")) {
    const it = await one<{ process_codes: string }>(db, `SELECT process_codes FROM monday_items WHERE item_id = ?`, [scope.slice(4)]);
    codes = it ? JSON.parse(it.process_codes ?? "[]") : [];
  }
  const now = nowIso();
  for (const code of codes) {
    for (const message of msgs) {
      await run(db, `INSERT INTO events (process_code, pi_number, step_key, type, message, actor, created_at) VALUES (?, NULL, ?, 'desenvolvimento', ?, ?, ?)`, [code, key, message, user, now]);
    }
  }
  // Quem observa o lançamento fica sabendo na hora (menos quem marcou).
  if (scope.startsWith("dev:")) await notifyDevChanges(db, { itemId: scope.slice(4), exclude: user });
  return next;
}

function fabStep(x: DevInputs): StepView {
  const def = STEP_BY_KEY.amostra_fab;
  if (!x.info) return step(def, "na", 0, "Sem lançamento no Monday");
  const d = x.amostra;
  // Amostra com rastreio, entregue ou avaliada: já foi fabricada.
  if (d.tracking || trackingDelivered(d) || d.approval) return step(def, "done", 1, "Amostra fabricada e enviada", { source: "manual" });
  return settle("amostra_fab", x, fromTasks("amostra_fab", x.info.tasks.amostra_fab, x.today), step(def, "todo", 0, "Aguardando a fabricação da amostra"));
}

function envioStep(x: DevInputs): StepView {
  const def = STEP_BY_KEY.amostra;
  const d = x.amostra;
  if (d.na) return step(def, "na", 0, "Não se aplica", { data: d });
  const delivered = trackingDelivered(d);
  const dest = d.destination || "Fortaleza";
  if (delivered) return step(def, "done", 1, `Entregue em ${dest} em ${fmtDate(delivered, true)}`, { data: d, source: d.fedex?.delivered_at ? "fedex" : "manual" });
  if (d.approval) return step(def, "done", 1, "Amostra recebida", { data: d, source: "manual" });
  if (d.tracking) {
    const p = d.fedex?.code === "OD" ? 0.7 : d.fedex?.code === "IT" || d.fedex?.code === "PU" ? 0.5 : 0.3;
    return step(def, d.fedex?.code === "DE" ? "risk" : "doing", p, trackingText(d) || "Rastreio informado", { data: d, source: "fedex" });
  }
  const v = settle("amostra", x, fromTasks("amostra", x.info?.tasks.amostra, x.today), step(def, "todo", 0, "Informar o rastreio da amostra"));
  return { ...v, data: d };
}

function validacaoStep(x: DevInputs): StepView {
  const def = STEP_BY_KEY.amostra_validacao;
  const d = x.amostra;
  if (d.na) return step(def, "na", 0, "Não se aplica", { data: d });
  if (d.approval === "aprovado" || d.approval === "aprovado_restricao") {
    return step(def, "done", 1, `${d.approval === "aprovado" ? "Aprovada" : "Aprovada com restrição"}${d.approval_at ? ` em ${fmtDate(d.approval_at, true)}` : ""}`, { data: d, source: "manual" });
  }
  if (d.approval === "reprovado") return step(def, "blocked", 0.5, `Reprovada${d.approval_note ? `: ${d.approval_note}` : ""}`, { data: d, source: "manual" });
  if (trackingDelivered(d)) return step(def, "doing", 0.5, "Amostra entregue · registrar a aprovação", { data: d });
  const v = settle("amostra_validacao", x, fromTasks("amostra_validacao", x.info?.tasks.amostra_validacao, x.today), step(def, "todo", 0, "Aguardando a amostra"));
  return { ...v, data: d };
}

function goproductStep(x: DevInputs): StepView {
  const def = STEP_BY_KEY.goproduct;
  const rows = x.skus.rows.filter((r) => r.code);
  const src = x.skus.source === "po" || x.skus.source === "planilha" ? x.skus.source : "manual";
  if (rows.length) {
    const ok = rows.filter((r) => r.goproduct);
    if (ok.length === rows.length) return step(def, "done", 1, rows.length === 1 ? "O SKU está no GoProduct" : `Os ${rows.length} SKUs estão no GoProduct`, { source: src });
    const miss = rows.filter((r) => !r.goproduct).map((r) => r.code);
    const v = step(def, ok.length ? "doing" : "todo", ok.length / rows.length * 0.9, `${ok.length} de ${rows.length} SKUs no GoProduct · faltam ${miss.slice(0, 4).join(", ")}${miss.length > 4 ? ` +${miss.length - 4}` : ""}`, { source: src });
    // Sem escalar para risco: o catálogo do GoProduct pode não ter o código exato (variações) de pedidos antigos.
    return v;
  }
  return settle("goproduct", x, fromTasks("goproduct", x.info?.tasks.goproduct, x.today), step(def, "todo", 0, "Informar a lista de SKUs"));
}

function docsStep(x: DevInputs): StepView {
  const def = STEP_BY_KEY.documentacao;
  const d = x.producao;
  const link = d.docs_link ?? x.docsFolder?.link ?? null;
  const extra = { data: { docs_done_at: d.docs_done_at ?? null, docs_link: d.docs_link ?? null, docs_by: d.docs_by ?? null, folder: link, folder_name: x.docsFolder?.name ?? null } };
  if (d.docs_done_at) return step(def, "done", 1, `Enviada em ${fmtDate(d.docs_done_at, true)}${d.docs_by?.startsWith("Drive") ? " (lida do Drive)" : ""}`, { ...extra, source: d.docs_by?.startsWith("Drive") ? "drive" : "manual" });
  if (x.shipped) return step(def, "done", 1, "Sem registro (o pedido já embarcou)", { ...extra, source: "inferido" });
  if (!x.hasCode) return step(def, "todo", 0, "Aguardando o pedido (PO) no FileMaker", extra);
  const tasks = fromTasks("documentacao", x.info?.tasks.documentacao, x.today);
  const base = x.docsFolder ? `Pasta ${x.docsFolder.name} no Drive · faltam carton marks e barcodes` : "Gerar a documentação no FileMaker (PO, carton marks, barcodes)";
  if (tasks && tasks.status === "done") return step(def, "doing", 0.6, `${base} · Monday: ${tasks.detail}`, extra);
  // Produção começada sem registro da documentação (pedidos de antes da conferência no Drive): segue sem marcar risco.
  return step(def, x.started ? "doing" : tasks ? tasks.status : "todo", tasks ? tasks.progress : x.started ? 0.5 : 0, base, extra);
}

/** As 8 etapas da trilha de desenvolvimento. */
export function devSteps(x: DevInputs): Record<string, StepView> {
  // Com a produção começada, o que vem antes dela já aconteceu (mesmo que o Monday não tenha sido atualizado).
  const early = (key: string, v: StepView) => (x.started && !DONE_STATUS.has(v.status) ? inferred(key) : v);
  return {
    ctr: applyManual("ctr", early("ctr", ctrStep(x)), x.manual?.ctr, x.today),
    waitlist: applyManual("waitlist", early("waitlist", waitlistStep(x)), x.manual?.waitlist, x.today),
    cores: applyManual("cores", early("cores", coresStep(x)), x.manual?.cores, x.today),
    amostra_fab: applyManual("amostra_fab", early("amostra_fab", fabStep(x)), x.manual?.amostra_fab, x.today),
    amostra: envioStep(x),
    amostra_validacao: validacaoStep(x),
    goproduct: goproductStep(x),
    documentacao: docsStep(x),
  };
}

function healthOf(steps: StepView[]): Health {
  if (steps.some((s) => s.status === "late" || s.status === "blocked")) return "late";
  if (steps.some((s) => s.status === "risk")) return "risk";
  return "ok";
}

/** Lançamento ainda sem pedido (ou visto fora do pedido): só a trilha de desenvolvimento. */
export function devProject(info: DevInfoView, skus: SkuListView, today: string, manual: Record<string, Record<string, any>> = {}, palette?: Palette): DevProjectView {
  const by = devSteps({ info, amostra: {}, producao: {}, docsFolder: null, shipped: false, started: (stageNumber(info.stage) ?? 0) >= 5, hasCode: info.process_codes.length > 0, skus, manual, palette, today });
  const steps = DEV_KEYS.map((k) => by[k]);
  const applicable = steps.filter((s) => s.status !== "na");
  const w = applicable.reduce((a, s) => a + STEP_BY_KEY[s.key].weight, 0) || 1;
  const total = applicable.reduce((a, s) => a + s.progress * STEP_BY_KEY[s.key].weight, 0) / w;
  const open = steps.find((s) => !DONE_STATUS.has(s.status));
  const tasks = DEV_KEYS.flatMap((k) => (info.tasks[k] ?? []).map((t) => ({ ...t, step: k })));
  const next = tasks.filter((t) => t.state !== "done" && t.state !== "na").sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))[0] ?? null;
  return {
    info,
    steps,
    total,
    health: healthOf(applicable),
    current: open ? `${open.label}${open.detail ? `: ${open.detail}` : ""}` : "Desenvolvimento concluído",
    next_task: next,
    skus,
  };
}

/** Lançamentos abertos com a trilha e a lista de SKUs (lista temporária gravada em "dev:<item>"). */
export async function devProjects(db: DB, itemId?: string | string[]): Promise<DevProjectView[]> {
  const infos = await openDevInfos(db, itemId);
  const scopes = infos.map((i) => `dev:${i.item_id}`);
  const codes = infos.flatMap((i) => i.process_codes);
  const [manualRows, rows, items] = await Promise.all([
    all<{ scope: string; step_key: string; data: string }>(db, `SELECT scope, step_key, data FROM step_state WHERE scope IN (SELECT value FROM json_each(?))`, [JSON.stringify(scopes)]),
    all<SkuDbRow>(db, `SELECT id, scope, code, name, qty, source FROM sku_lists WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY id`, [JSON.stringify([...scopes, ...codes])]),
    codes.length ? all<{ process_code: string; sku_code: string | null; sku: string | null; qty: number | null }>(db, `SELECT process_code, sku_code, sku, qty FROM order_items WHERE removed_at IS NULL AND process_code IN (SELECT value FROM json_each(?))`, [JSON.stringify(codes)]) : [],
  ]);
  const gp = await goproductByCode(db, [...rows.map((r) => r.code ?? ""), ...items.map((i) => i.sku_code ?? "")]);
  const palette = await loadPalette(db);
  const galeria = await galeriaByItem(db, infos.map((i) => i.item_id));
  const today = todayBR();
  return infos.map((info) => {
    const mine = [`dev:${info.item_id}`, ...info.process_codes];
    const skus = buildSkuList(
      info.process_codes[0] ?? `dev:${info.item_id}`,
      rows.filter((r) => mine.includes(r.scope)),
      items.filter((i) => info.process_codes.includes(i.process_code)).map((i) => ({ code: i.sku_code, name: i.sku, qty: i.qty })),
      gp,
    );
    const manual: Record<string, Record<string, any>> = {};
    for (const m of manualRows) if (m.scope === `dev:${info.item_id}`) manual[m.step_key] = JSON.parse(m.data);
    return { ...devProject(info, skus, today, manual, palette), galeria: galeria.get(info.item_id) ?? null };
  });
}

// ---------- Observadores automáticos ----------

/**
 * Quem está na coluna People de um lançamento aberto, ou observa o lançamento no Freeway, passa a
 * observar o pedido ligado a ele. Uma vez só por pessoa e pedido: quem deixar de observar não volta a ser incluído.
 */
export async function autoWatch(db: DB): Promise<number> {
  const followers = new Map<string, string[]>();
  for (const w of await all<{ item_id: string; user_email: string }>(db, `SELECT item_id, user_email FROM dev_watchers`)) followers.set(w.item_id, [...(followers.get(w.item_id) ?? []), w.user_email]);
  const infos = (await openDevInfos(db)).filter((i) => i.process_codes.length && (i.emails.length || followers.has(i.item_id)));
  const known = new Set((await all<{ process_code: string }>(db, `SELECT process_code FROM orders`)).map((r) => r.process_code));
  let added = 0;
  for (const i of infos) {
    for (const code of i.process_codes) {
      if (!known.has(code)) continue;
      for (const email of new Set([...i.emails, ...(followers.get(i.item_id) ?? [])])) {
        if (await one(db, `SELECT 1 FROM auto_watch WHERE process_code = ? AND user_email = ?`, [code, email])) continue;
        await run(db, `INSERT INTO auto_watch (process_code, user_email, item_id, created_at) VALUES (?, ?, ?, ?)`, [code, email, i.item_id, nowIso()]);
        added += await run(db, `INSERT OR IGNORE INTO watchers (process_code, user_email, created_at) VALUES (?, ?, ?)`, [code, email, nowIso()]);
      }
    }
  }
  return added;
}

// ---------- Quem observa o lançamento ----------

/** Lançamentos que a pessoa observa, o mais recente primeiro. */
export async function watchedDevIds(db: DB, user: string): Promise<string[]> {
  return (await all<{ item_id: string }>(db, `SELECT item_id FROM dev_watchers WHERE user_email = ? ORDER BY created_at DESC`, [user])).map((r) => r.item_id);
}

/** Marca nos lançamentos quais a pessoa observa. */
export async function markWatching(db: DB, projects: DevProjectView[], user: string): Promise<DevProjectView[]> {
  const mine = new Set(await watchedDevIds(db, user));
  for (const p of projects) p.watching = mine.has(p.info.item_id);
  return projects;
}

export async function setDevWatch(db: DB, itemId: string, user: string, on: boolean): Promise<void> {
  if (!(await one(db, `SELECT 1 FROM monday_items WHERE item_id = ?`, [itemId]))) throw new Error("Lançamento não encontrado");
  if (!on) {
    await run(db, `DELETE FROM dev_watchers WHERE item_id = ? AND user_email = ?`, [itemId, user]);
    return;
  }
  await run(db, `INSERT OR IGNORE INTO dev_watchers (item_id, user_email, created_at) VALUES (?, ?, ?)`, [itemId, user, nowIso()]);
  // Guarda a situação de agora: os avisos são do que mudar daqui em diante.
  await notifyDevChanges(db, { itemId, exclude: user });
}

const DEV_NOTIFY: Partial<Record<StepStatus, string>> = { done: "concluída", late: "atrasada", blocked: "bloqueada", risk: "em risco" };

/**
 * Avisa quem observa o lançamento quando uma etapa fica concluída, atrasada, bloqueada ou em risco.
 * Etapa vista pela primeira vez só guarda a situação, sem aviso.
 */
export async function notifyDevChanges(db: DB, opts: { itemId?: string; exclude?: string } = {}): Promise<{ observados: number; avisos: number }> {
  const ids = (await all<{ item_id: string }>(db, `SELECT DISTINCT item_id FROM dev_watchers ${opts.itemId ? "WHERE item_id = ?" : ""}`, opts.itemId ? [opts.itemId] : [])).map((r) => r.item_id);
  if (!ids.length) return { observados: 0, avisos: 0 };
  const projects = await devProjects(db, opts.itemId ?? ids);
  const seen = new Map(
    (await all<{ item_id: string; step_key: string; status: string }>(db, `SELECT item_id, step_key, status FROM dev_step_seen WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)])).map((r) => [`${r.item_id}#${r.step_key}`, r.status]),
  );
  const now = nowIso();
  const today = todayBR();
  const rows: { item_id: string; step_key: string; status: string; updated_at: string }[] = [];
  const specs: NotificationSpec[] = [];
  for (const p of projects) {
    const id = p.info.item_id;
    for (const s of p.steps) {
      const prev = seen.get(`${id}#${s.key}`);
      if (prev === s.status) continue;
      rows.push({ item_id: id, step_key: s.key, status: s.status, updated_at: now });
      const what = DEV_NOTIFY[s.status];
      if (prev === undefined || !what) continue;
      specs.push({
        nkey: `dev:${id}:${s.key}:${s.status}:${today}`,
        process_code: `dev:${id}`,
        step_key: s.key,
        kind: "desenvolvimento",
        title: `${p.info.name}: etapa ${s.label} ${what}`,
        body: s.detail || null,
        exclude: opts.exclude ?? null,
      });
    }
  }
  if (rows.length) await upsertJson(db, "dev_step_seen", ["item_id", "step_key", "status", "updated_at"], ["item_id", "step_key"], rows);
  return { observados: projects.length, avisos: await deliver(db, specs) };
}

// ---------- PO do FileMaker ----------

/** Lê a lista de SKUs das POs (.xlsx) nas pastas dos pedidos no Drive do FileMaker, quando o arquivo muda. */
export async function refreshPoLists(db: DB, env: Env): Promise<Record<string, unknown>> {
  const { driveAuth, children, isFolder } = await import("../integrations/drive");
  const auth = await driveAuth(env);
  const folders = await all<{ process_code: string; folder_id: string; drive_id: string | null }>(db, `SELECT process_code, folder_id, drive_id FROM order_docs`);
  const known = new Map((await all<{ process_code: string; file_id: string; modified_at: string }>(db, `SELECT process_code, file_id, modified_at FROM po_files`)).map((r) => [r.process_code, r]));
  let parsed = 0;
  for (const f of folders) {
    const files = (await children(auth, f.folder_id, { driveId: f.drive_id ?? undefined, max: 100 })).filter((x) => !isFolder(x));
    const po = files.filter((x) => /^PO\b/i.test(x.name) && /\.xlsx$/i.test(x.name)).sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))[0];
    if (!po) continue;
    const prev = known.get(f.process_code);
    if (prev && prev.file_id === po.id && prev.modified_at === (po.modifiedTime ?? "")) continue;
    let rows: ReturnType<typeof parseSkuGrid> = [];
    let error: string | null = null;
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${po.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${auth}` } });
      if (!res.ok) throw new Error(`Drive ${res.status}`);
      const book = await readXlsx(new Uint8Array(await res.arrayBuffer()));
      for (const g of Object.values(book)) {
        rows = parseSkuGrid(g);
        if (rows.length) break;
      }
      if (!rows.length) error = "não achei a tabela de itens na PO";
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
    if (rows.length) {
      await run(db, `DELETE FROM sku_lists WHERE scope = ? AND source = 'po'`, [f.process_code]);
      const now = nowIso();
      for (const r of rows) await run(db, `INSERT INTO sku_lists (scope, code, name, qty, source, created_by, created_at) VALUES (?, ?, ?, ?, 'po', ?, ?)`, [f.process_code, r.code, r.name, r.qty, `Drive (${po.name})`, now]);
      parsed++;
    }
    await run(
      db,
      `INSERT INTO po_files (process_code, file_id, file_name, modified_at, rows, error, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(process_code) DO UPDATE SET file_id = excluded.file_id, file_name = excluded.file_name, modified_at = excluded.modified_at, rows = excluded.rows, error = excluded.error, parsed_at = excluded.parsed_at`,
      [f.process_code, po.id, po.name, po.modifiedTime ?? "", rows.length, error, nowIso()],
    );
    console.log(`[po] ${f.process_code}: ${po.name} · ${rows.length} SKUs${error ? ` · ${error}` : ""}${rows.length ? ` · ${fmtQty(rows.reduce((a, r) => a + (r.qty ?? 0), 0))} un.` : ""}`);
  }
  return { folders: folders.length, parsed };
}

