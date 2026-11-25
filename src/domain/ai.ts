import type { DB, Env } from "../env";
import { all, nowIso, one, run, todayBR } from "../db/q";
import { aiConfigured, chatJson } from "../integrations/aiproxy";
import { hash } from "../sheet/sync";
import type { OrderView } from "../shared/types";
import { TEAM_LABEL } from "./steps";
import { loadViews } from "./view";

const SYSTEM = `Você ajuda a acompanhar pedidos de importação da Gocase.
Recebe tudo o que o Freeway sabe de um processo: as etapas calculadas pelo sistema, as anotações livres da planilha do time de importação,
os itens dos quadros do Monday ligados ao pedido (lançamento, inspeção, amostras), a industrialização em Itapeva (GDI),
a documentação no Drive e a linha do tempo do que mudou. As anotações da planilha são um diário com a data mais recente primeiro ("dd/mm: ...").
Cruze as fontes: quando uma contradiz a outra (ex.: Monday diz atrasado e a planilha não), aponte em "atencao".

Responda APENAS com um objeto JSON neste formato:
{
  "resumo": "1 ou 2 frases curtas sobre em que pé o pedido está agora",
  "atencao": "risco atual em uma frase (atraso, ETA postergado, canal vermelho, exigência, on hold) ou null",
  "embarques": { "<código do embarque, ex. BBI25205.2>": "situação atual em até 15 palavras" },
  "pendencias": [ { "texto": "ação concreta em aberto, começando por verbo", "embarque": "<código> ou null", "responsavel": "importacao | itapeva | ecommerce | filmagem | ilustracao | marketing | null" } ],
  "rastreios": [ { "codigo": "número de rastreio citado", "transportadora": "FedEx | DHL | UPS | Correios | outro", "contexto": "do que é, em poucas palavras" } ]
}

Regras:
- Use só o que está no texto. Não invente datas, números nem códigos.
- Considere só a anotação mais recente de cada embarque para dizer a situação atual; as antigas servem de contexto.
- Pendência só quando alguma fonte indicar algo em aberto ("aguardando", "ag.", "solicitar", "acompanhar", "pendente", "programar", "confirmar", inspeção reprovada, lançamento atrasado). No máximo 5, sem repetir os próximos passos que o sistema já mostra.
- "embarques" só para os embarques em aberto listados.
- Português, frases curtas, sem markdown.`;

const NOTE_CHARS = 700;
const MAX_SHIPMENTS = 30;
const MAX_EVENTS = 15;

/** O que vem de fora do cálculo das etapas: itens do Monday ligados ao pedido e a linha do tempo. */
export interface AiExtras {
  monday: { name: string; group_title: string | null; vals: string; board: string | null; row_hash: string | null }[];
  events: { id: number; created_at: string; message: string; actor: string }[];
}

export async function loadAiExtras(db: DB, code: string): Promise<AiExtras> {
  const [monday, events] = await Promise.all([
    all<AiExtras["monday"][number]>(
      db,
      `SELECT m.name, m.group_title, m.vals, m.row_hash,
              (SELECT json_extract(j.value, '$.name') FROM settings s, json_each(s.value) j
                WHERE s.key = 'monday_boards' AND json_extract(j.value, '$.id') = m.board_id) AS board
         FROM monday_items m
        WHERE EXISTS (SELECT 1 FROM json_each(m.process_codes) c WHERE c.value = ?)
           OR m.item_id IN (SELECT l.item_id FROM sample_links l, json_each(l.process_codes) c WHERE c.value = ?)
        ORDER BY m.updated_at DESC LIMIT 20`,
      [code, code],
    ),
    all<AiExtras["events"][number]>(db, `SELECT id, created_at, message, actor FROM events WHERE process_code = ? ORDER BY id DESC LIMIT ?`, [code, MAX_EVENTS]),
  ]);
  return { monday, events };
}

const MONDAY_SKIP = /photo|image|arquivo|relatorio|ficha|file|pdf|subite|subelement|mirror|conectar|people|person|notify/i;

/**
 * Monta o que a IA lê: tudo do pedido. Devolve também a chave do hash, feita
 * só de fatos estáveis (status, datas, valores), sem os textos que mudam todo
 * dia ("faltam 3 dias"), para a IA só ler de novo quando algo mudar de verdade.
 */
export function buildAiInput(v: OrderView, extras: AiExtras): { input: string; key: string } {
  const lines: string[] = [];
  const key: unknown[] = [v.notes, v.po_status];
  lines.push(`Processo ${v.process_code} (${v.kind}) · ${v.description ?? "sem descrição"} · fornecedor ${v.supplier ?? "-"} · importação ${v.po_status ?? "-"}`);
  lines.push(`Hoje: ${todayBR()}`);
  if (v.hold) {
    lines.push(`Situação no Freeway: ${v.hold.state === "cancelado" ? "CANCELADO" : "ON HOLD"}${v.hold.note ? ` (motivo: ${v.hold.note})` : ""}`);
    key.push(v.hold.state, v.hold.note);
  }
  lines.push("Etapas do pedido (calculadas pelo sistema):");
  for (const s of v.steps) {
    if (s.scope !== "order" || s.status === "na") continue;
    const pts = (s.points ?? []).map((p) => `${p.label}: ${p.done ? "pronta" : "pendente"}`).join("; ");
    lines.push(`- ${s.label}: ${s.status} · ${s.detail}${pts ? ` · ${pts}` : ""}`);
    key.push(s.key, s.status, s.due, (s.points ?? []).map((p) => p.done));
  }
  if (v.notes) lines.push(`\nAnotações do processo (Outras informações):\n${v.notes.slice(0, 1500)}`);
  for (const s of v.samples) {
    lines.push(`Amostra no Monday (Warehouse Samples): ${s.tracking || s.name}${s.approval ? ` · aprovação ${s.approval}` : ""}${s.received ? ` · recebida ${s.received}` : ""} · ${s.state}`);
    key.push(s.item_id, s.state, s.approval);
  }

  const ships = v.units.filter((u) => u.shipment);
  const open = ships.filter((u) => u.shipment!.status !== "entregue").slice(0, MAX_SHIPMENTS);
  const delivered = ships.filter((u) => u.shipment!.status === "entregue");
  if (open.length) {
    lines.push("\nEmbarques em aberto:");
    for (const u of open) {
      const s = u.shipment!;
      const bits = [u.display, s.status_label];
      if (s.etd) bits.push(`ETD ${s.etd}`);
      if (s.eta) bits.push(`ETA Santos ${s.eta}`);
      if (s.canal) bits.push(`canal ${s.canal}`);
      if (s.duimp_at) bits.push(`DUIMP ${s.duimp_at}`);
      lines.push(`- ${bits.join(" · ")}${s.notes ? `\n  Anotações: ${s.notes.slice(0, NOTE_CHARS)}` : ""}`);
      key.push(u.display, s.status, s.eta, s.canal, s.duimp_at, s.notes);
    }
  }
  // Frete entregue: o que importa é Itapeva (industrialização, FCI) e a trilha do site.
  const active = v.units.filter((u) => !u.finalized && (u.kind === "pedido" || u.shipment?.status === "entregue")).slice(0, MAX_SHIPMENTS);
  if (active.length) {
    lines.push("\nDepois da chegada (por frete):");
    for (const u of active) {
      const steps = u.steps.filter((s) => s.scope === "unit" && s.status !== "na" && ["industrializacao", "fci", "mockups", "cadastro_site", "cadastro_wms", "lancamento", "filmagem", "estampas", "marketing"].includes(s.key));
      lines.push(`- ${u.display}: ${steps.map((s) => `${s.short} ${s.status}${s.key === "industrializacao" && s.detail ? ` (${s.detail})` : ""}`).join(" · ")}`);
      key.push(u.display, steps.map((s) => [s.key, s.status, s.due]), u.items.map((i) => [i.done_at, i.gdi?.done, i.gdi?.doing]));
    }
  }
  if (delivered.length) lines.push(`\nEmbarques já entregues: ${delivered.length}`);
  const saldo = v.units.find((u) => u.kind !== "embarque")?.balance_qty ?? 0;
  if (saldo > 0) lines.push(`Saldo ainda em produção: ${Math.round(saldo)} unidades`);

  if (extras.monday.length) {
    lines.push("\nQuadros do Monday ligados a este pedido:");
    for (const m of extras.monday) {
      const vals = Object.entries(JSON.parse(m.vals ?? "{}") as Record<string, string>).filter(([k]) => !MONDAY_SKIP.test(k)).map(([k, val]) => `${k}: ${String(val).slice(0, 120)}`);
      lines.push(`- [${m.board ?? "Monday"}] ${m.name}${m.group_title ? ` (grupo ${m.group_title})` : ""}${vals.length ? ` · ${vals.join("; ")}` : ""}`);
      key.push(m.row_hash);
    }
  }
  if (extras.events.length) {
    lines.push("\nLinha do tempo (mais recente primeiro):");
    for (const e of extras.events) lines.push(`- ${e.created_at.slice(0, 10)} · ${e.message} (${e.actor})`);
    key.push(extras.events[0].id);
  }
  return { input: lines.join("\n"), key: JSON.stringify(key) };
}

function clean(data: any) {
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 400) : null);
  const embarques: Record<string, string> = {};
  for (const [k, val] of Object.entries(data?.embarques ?? {})) if (str(val)) embarques[k] = str(val)!;
  return {
    resumo: str(data?.resumo),
    atencao: str(data?.atencao),
    embarques,
    pendencias: (Array.isArray(data?.pendencias) ? data.pendencias : [])
      .filter((p: any) => str(p?.texto))
      .slice(0, 5)
      .map((p: any) => ({ texto: str(p.texto)!, embarque: str(p.embarque), responsavel: TEAM_LABEL[p.responsavel] ? p.responsavel : null })),
    rastreios: (Array.isArray(data?.rastreios) ? data.rastreios : [])
      .filter((r: any) => str(r?.codigo))
      .slice(0, 10)
      .map((r: any) => ({ codigo: String(r.codigo).replace(/\s/g, ""), transportadora: str(r.transportadora), contexto: str(r.contexto) })),
  };
}

export interface AiRun {
  checked: number;
  called: number;
  errors: number;
  skipped: number;
}

/**
 * Leitura da IA dos processos indicados (ou dos observados): tudo o que o
 * Freeway sabe de cada pedido. Só chama a IA quando algo mudou de verdade.
 */
export async function refreshAi(db: DB, env: Env, codes?: string[], opts: { force?: boolean; max?: number } = {}): Promise<AiRun> {
  const run_: AiRun = { checked: 0, called: 0, errors: 0, skipped: 0 };
  if (!aiConfigured(env)) return run_;
  const list = codes ?? (await all<{ process_code: string }>(db, `SELECT DISTINCT process_code FROM watchers`)).map((r) => r.process_code);
  // Na rotina, pedido cancelado ou on hold não é relido (só quando alguém pede).
  const views = (await loadViews(db, list)).filter((v) => codes || (!v.hold && v.po_status !== "Cancelada"));
  const max = opts.max ?? 10;
  for (const v of views) {
    run_.checked++;
    const { input, key } = buildAiInput(v, await loadAiExtras(db, v.process_code));
    const h = hash(key);
    const prev = await one<{ input_hash: string; error: string | null }>(db, `SELECT input_hash, error FROM ai_insights WHERE process_code = ?`, [v.process_code]);
    if (!opts.force && prev && prev.input_hash === h && !prev.error) {
      run_.skipped++;
      continue;
    }
    if (run_.called >= max) break;
    run_.called++;
    try {
      const r = await chatJson(env, SYSTEM, input);
      await run(
        db,
        `INSERT INTO ai_insights (process_code, input_hash, result, error, model, tokens, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(process_code) DO UPDATE SET input_hash = excluded.input_hash, result = excluded.result, error = NULL,
           model = excluded.model, tokens = excluded.tokens, created_at = excluded.created_at`,
        [v.process_code, h, JSON.stringify(clean(r.data)), r.model, r.tokens, nowIso()],
      );
      console.log(`[ia] ${v.process_code} ok tokens=${r.tokens ?? "?"} modelo=${r.model ?? "?"}`);
    } catch (e) {
      run_.errors++;
      const msg = (e as Error).message.slice(0, 500);
      console.log(`[ia] ${v.process_code} erro: ${msg}`);
      // Guarda o erro sem apagar a última leitura boa.
      await run(
        db,
        `INSERT INTO ai_insights (process_code, input_hash, result, error, created_at) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(process_code) DO UPDATE SET input_hash = excluded.input_hash, error = excluded.error`,
        [v.process_code, h, msg, nowIso()],
      );
    }
  }
  return run_;
}

export async function aiStatus(db: DB): Promise<{ last_at: string | null; ok: number; errors: number; last_error: string | null }> {
  const row = await one<any>(
    db,
    `SELECT MAX(created_at) AS last_at, SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
            (SELECT error FROM ai_insights WHERE error IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_error
       FROM ai_insights`,
  );
  return { last_at: row?.last_at ?? null, ok: row?.ok ?? 0, errors: row?.errors ?? 0, last_error: row?.last_error ?? null };
}
