import type { DB, Env } from "../env";
import { all, nowIso, one, run, upsertJson } from "../db/q";
import type { GaleriaInfo } from "../shared/types";
import { galeriaConfigured, galeriaLaunches } from "../integrations/galeria";
import { launchBoards, nameWords } from "./dev";

// Galeria de Lançamentos, lida de hora em hora: fotos escolhidas, preço, custo, margem, CTR e projeção de receita
// de cada lançamento, ligados ao item do Monday pelo link que a Galeria guarda (ou pelo nome, quando falta).

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    // "1.234,56" (com vírgula) é número brasileiro; "99.9", número com ponto decimal.
    const t = v.trim().replace(/^R\$\s*/, "");
    const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Fotos escolhidas na Galeria (até 6), servidas pela rota do Freeway que busca a imagem com a chave. */
function photos(l: Record<string, any>): string[] {
  const list: any[] = Array.isArray(l._media) && l._media.length ? l._media : Array.isArray(l._mediaAll) ? l._mediaAll : [];
  return list
    .filter((m) => m && typeof m.id === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(m.id) && (m.type === "image" || String(m.mimeType ?? "").startsWith("image/")))
    .slice(0, 6)
    .map((m) => {
      const v = String(m.src ?? "").match(/[?&]v=([0-9A-Za-z_-]+)/)?.[1];
      return `/api/galeria/img/${m.id}${v ? `?v=${v}` : ""}`;
    });
}

export function galeriaInfo(l: Record<string, any>, via: GaleriaInfo["via"]): GaleriaInfo {
  const receita = l.revenuePerMonth && typeof l.revenuePerMonth === "object" ? Object.entries(l.revenuePerMonth) : [];
  return {
    slug: str(l._slug) ?? String(l.nome ?? ""),
    nome: String(l.nome ?? ""),
    mes: str(l.mes),
    tipo: str(l.tipo),
    categoria: str(l.categoria),
    subcategoria: str(l.subcategoria),
    status: str(l.statusLancamento),
    teste: str(l.teste),
    status_teste: str(l.statusTeste),
    preco: num(l.preco),
    custo: num(l.custo),
    fob: num(l.fob),
    margem: num(l.margem),
    ctr: num(l.ctr),
    cpc: num(l.cpc),
    custo_lead: num(l.custoLead),
    lead_click: num(l.leadClick),
    proj2026: num(l.proj2026),
    proj2027: num(l.proj2027),
    rec_estimada: num(l.recEstimada),
    receita_mes: receita.map(([mes, v]) => ({ mes, valor: num(v) ?? 0 })).filter((r) => r.valor > 0),
    fotos: photos(l),
    comentarios: num(l._commentCount) ?? 0,
    via,
  };
}

const pulseOf = (l: Record<string, any>): string | null => String(l._mondayUrl ?? "").match(/\/pulses\/(\d+)/)?.[1] ?? null;

export async function refreshGaleria(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!galeriaConfigured(env)) return { skipped: "GALERIA_API_KEY não configurada" };
  const list = (await galeriaLaunches(env)).filter((l) => !l._hidden && str(l.nome));
  // Lançamentos dos quadros Launches, para ligar pelo nome os que a Galeria não liga ao Monday.
  const boards = await launchBoards(db);
  const items = boards.length
    ? await all<{ item_id: string; name: string }>(db, `SELECT item_id, name FROM monday_items WHERE board_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(boards.map((b) => b.id))])
    : [];
  const linked = new Set(list.map(pulseOf).filter(Boolean));
  const free = items.filter((i) => !linked.has(i.item_id)).map((i) => ({ item_id: i.item_id, words: new Set(nameWords(i.name)) }));
  const now = nowIso();
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let porLink = 0;
  let porNome = 0;
  for (const l of list) {
    let item = pulseOf(l);
    let via: GaleriaInfo["via"] = "monday";
    if (!item) {
      // Pelo nome: todas as palavras em comum (sem a categoria entre colchetes), sem empate.
      const want = new Set(nameWords(String(l.nome)));
      let best: string | null = null;
      let score = 0;
      let second = 0;
      for (const i of free) {
        if (!want.size || !i.words.size) continue;
        const sc = [...want].filter((w) => i.words.has(w)).length / Math.max(want.size, i.words.size);
        if (sc > score) [second, score, best] = [score, sc, i.item_id];
        else if (sc > second) second = sc;
      }
      if (best && score >= 0.75 && score > second) [item, via] = [best, "nome"];
    }
    if (item) via === "monday" ? porLink++ : porNome++;
    const info = galeriaInfo(l, via);
    if (seen.has(info.slug)) continue;
    seen.add(info.slug);
    rows.push({ slug: info.slug, item_id: item, via: item ? via : null, data: JSON.stringify(info), updated_at: now });
  }
  await run(db, `DELETE FROM galeria_launches`);
  if (rows.length) await upsertJson(db, "galeria_launches", ["slug", "item_id", "via", "data", "updated_at"], ["slug"], rows);
  // Quantos caem nos quadros Launches que o Freeway acompanha (os outros são de quadros antigos).
  const ours = new Set(items.map((i) => i.item_id));
  return {
    lancamentos: rows.length,
    por_link: porLink,
    por_nome: porNome,
    sem_vinculo: rows.length - porLink - porNome,
    nos_quadros_launches: rows.filter((r) => r.item_id && ours.has(r.item_id as string)).length,
    com_foto: list.filter((l) => photos(l).length).length,
  };
}

/** A Galeria de cada lançamento do Monday. Com dois no mesmo item, fica o ligado pelo link. */
export async function galeriaByItem(db: DB, ids: string[]): Promise<Map<string, GaleriaInfo>> {
  const out = new Map<string, GaleriaInfo>();
  if (!ids.length) return out;
  const rows = await all<{ item_id: string; via: string; data: string }>(db, `SELECT item_id, via, data FROM galeria_launches WHERE item_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
  rows.sort((a, b) => (a.via === "monday" ? 0 : 1) - (b.via === "monday" ? 0 : 1));
  for (const r of rows) if (!out.has(r.item_id)) out.set(r.item_id, JSON.parse(r.data));
  return out;
}

/** Só servimos imagens que a Galeria lista em algum lançamento. */
export async function galeriaPhotoKnown(db: DB, id: string): Promise<boolean> {
  return !!(await one(db, `SELECT 1 FROM galeria_launches WHERE instr(data, ?) > 0 LIMIT 1`, [`/api/galeria/img/${id}`]));
}
