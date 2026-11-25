import type { DB, Env } from "../env";
import { all, nowIso, one, run } from "../db/q";
import { aiConfigured, chatJson } from "../integrations/aiproxy";
import { findCodes, itemAssets, sampleTracking, type MondayItem } from "../integrations/monday";
import { hash } from "../sheet/sync";
import { insertEvents, type NewEvent } from "./events";
import { HttpError } from "./actions";

// Com confiança a partir daqui a ligação vale sozinha; abaixo, o app pede confirmação.
const AUTO = 0.8;
// Itens novos ou alterados lidos pela IA por rodada (a rotina roda a cada 30 min).
const PER_RUN = 12;
const RECENT_DAYS = 90;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function photo(env: Env, itemId: string): Promise<string | null> {
  const img = ((await itemAssets(env, [itemId])).get(itemId) ?? []).find((a) => ["jpg", "jpeg", "png", "webp", "gif"].includes(a.ext));
  if (!img) return null;
  const res = await fetch(img.url);
  const buf = await res.arrayBuffer();
  if (!res.ok || buf.byteLength > 4_000_000) return null;
  return `data:image/${img.ext === "jpg" ? "jpeg" : img.ext};base64,${toBase64(buf)}`;
}

const SYSTEM = `Você liga amostras recebidas no armazém da Gocase (quadro Warehouse Samples do Monday) aos pedidos de importação.
A principal evidência é o nome do item (produto, modelo, cor) e o fornecedor. A foto, quando vier, é só apoio.
Uma amostra pode ser de mais de um pedido, ou de nenhum (amostra de um produto que ainda não virou pedido).
Escolha só entre os pedidos candidatos. Responda apenas com JSON:
{ "processos": ["GOC00000"], "confianca": 0.0, "evidencia": "frase curta: por que esses pedidos" }`;

/**
 * Códigos dos pedidos candidatos de um fornecedor (pedidos abertos ou do último
 * ano). Consulta leve, guardada por fornecedor durante a rodada: serve para
 * saber se algo mudou sem refazer a busca para cada amostra.
 */
function candidateCodes(db: DB, memo: Map<string, Promise<string[]>>, supplier: string): Promise<string[]> {
  const word = (supplier.split(/\s+/)[0] ?? "").toLowerCase();
  const key = word.length >= 3 ? word : "";
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      const base = `SELECT o.process_code FROM orders o
                     WHERE o.removed_at IS NULL AND COALESCE(o.po_status, '') <> 'Cancelada'
                       AND (o.po_status = 'Aberta' OR o.po_date >= date('now', '-12 months'))`;
      const bySupplier = key ? await all<{ process_code: string }>(db, `${base} AND o.supplier LIKE ? ORDER BY o.po_date DESC LIMIT 40`, [`%${key}%`]) : [];
      const rows = bySupplier.length ? bySupplier : await all<{ process_code: string }>(db, `${base} ORDER BY o.po_date DESC LIMIT 60`);
      return rows.map((r) => r.process_code);
    })());
  }
  return memo.get(key)!;
}

/** Fornecedor, descrição e SKUs só dos candidatos que vão para a IA. */
async function candidateDetails(db: DB, codes: string[]) {
  return all(
    db,
    `SELECT o.process_code, o.supplier, o.description, o.po_date,
            (SELECT group_concat(COALESCE(i.sku_code, '') || ' ' || COALESCE(i.sku, ''), '; ')
               FROM (SELECT sku_code, sku FROM order_items WHERE process_code = o.process_code AND removed_at IS NULL LIMIT 10) i) AS skus
       FROM orders o WHERE o.process_code IN (SELECT value FROM json_each(?))
      ORDER BY o.po_date DESC`,
    [JSON.stringify(codes)],
  );
}

/**
 * Liga as amostras recentes do Warehouse Samples aos pedidos. Código no item
 * liga direto; senão a IA decide pelo nome e fornecedor e, sem segurança, olha
 * também a foto. Cada item só volta para a IA se ele ou os candidatos mudarem.
 */
export async function linkSamples(db: DB, env: Env, items: MondayItem[], known: Set<string>): Promise<Record<string, number>> {
  const since = new Date(Date.now() - RECENT_DAYS * 86400_000).toISOString();
  const recent = items.filter((it) => (it.updated_at ?? "") >= since).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const prev = new Map(
    (await all<{ item_id: string; status: string; input_hash: string; rejected: string; confirmed: string }>(db, `SELECT item_id, status, input_hash, rejected, confirmed FROM sample_links`)).map((r) => [r.item_id, r]),
  );
  const out = { lidos: 0, auto: 0, pendente: 0, sem_pedido: 0, codigo: 0 };
  const memo = new Map<string, Promise<string[]>>();
  for (const it of recent) {
    const link = prev.get(it.id);
    if (link?.status === "confirmado") continue;
    const rejected: string[] = JSON.parse(link?.rejected ?? "[]");
    const supplier = it.values["Supplier"] ?? "";
    const codes = (await candidateCodes(db, memo, supplier)).filter((c) => !rejected.includes(c));
    const inputHash = hash(JSON.stringify([it.name, supplier, codes]));
    if (link?.input_hash === inputHash) continue;

    const direct = findCodes(it, known).codes.filter((c) => !rejected.includes(c));
    let res: { processos: string[]; confianca: number; evidencia: string };
    let usedImage = false;
    if (direct.length) {
      res = { processos: direct, confianca: 1, evidencia: "Código do pedido no próprio item" };
      out.codigo++;
    } else {
      if (!aiConfigured(env) || out.lidos >= PER_RUN) break;
      const cands = await candidateDetails(db, codes);
      const tracking = sampleTracking(it.name, it.values);
      const text = [
        `Item no Monday: ${it.name}${tracking ? ` (rastreio ${tracking})` : ""} · grupo ${it.group ?? "-"}`,
        ...Object.entries(it.values).filter(([k]) => !/photo|image|arquivo|relatorio|ficha|mirror|conectar|samples china/i.test(k)).map(([k, v]) => `${k}: ${v.slice(0, 200)}`),
        "",
        "Pedidos candidatos:",
        ...cands.map((c) => `- ${c.process_code} · ${c.supplier ?? "-"} · ${c.description ?? "-"} · PO ${c.po_date ?? "-"} · ${c.skus ?? ""}`),
      ].join("\n");
      const ask = async (images: string[] = []) => {
        const d = (await chatJson(env, SYSTEM, text, images)).data;
        const valid = new Set(cands.map((c) => c.process_code as string));
        return { processos: (Array.isArray(d.processos) ? d.processos : []).filter((c: string) => valid.has(c)), confianca: Number(d.confianca) || 0, evidencia: String(d.evidencia ?? "").slice(0, 400) };
      };
      try {
        out.lidos++;
        res = await ask();
        if (res.confianca < AUTO && (it.values["Photo"] || it.values["Product Image"])) {
          const img = await photo(env, it.id);
          if (img) {
            res = await ask([img]);
            usedImage = true;
          }
        }
      } catch (err) {
        console.log(`[amostras] ${it.name}: erro ${(err as Error).message}`);
        continue;
      }
    }

    const status = !res.processos.length ? "sem_pedido" : res.confianca >= AUTO ? "auto" : "pendente";
    out[status as "auto" | "pendente" | "sem_pedido"]++;
    await run(
      db,
      `INSERT INTO sample_links (item_id, process_codes, confirmed, rejected, confidence, status, evidence, used_image, input_hash, decided_at)
       VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET process_codes = excluded.process_codes, confidence = excluded.confidence, status = excluded.status,
         evidence = excluded.evidence, used_image = excluded.used_image, input_hash = excluded.input_hash, decided_at = excluded.decided_at`,
      [it.id, JSON.stringify(res.processos), JSON.stringify(rejected), res.confianca, status, res.evidencia, usedImage ? 1 : 0, inputHash, nowIso()],
    );
    if (status === "auto") {
      const label = sampleTracking(it.name, it.values) || it.name;
      await insertEvents(db, res.processos.map((code): NewEvent => ({
        process_code: code, step_key: "amostra", type: "amostra_monday", actor: "IA (Monday)",
        message: `Amostra do Monday ligada a este pedido: ${label}${label !== it.name ? ` (${it.name})` : ""} · ${Math.round(res.confianca * 100)}%`,
      })));
    }
  }
  console.log(`[amostras] ${JSON.stringify(out)}`);
  return out;
}

/** Confirmação no app: a amostra é (ok) ou não é deste pedido. */
export async function decideSample(db: DB, itemId: string, code: string, ok: boolean, user: string): Promise<void> {
  const row = await one(db, `SELECT l.*, m.name FROM sample_links l JOIN monday_items m ON m.item_id = l.item_id WHERE l.item_id = ?`, [itemId]);
  if (!row) throw new HttpError(404, "Amostra não encontrada");
  let codes: string[] = JSON.parse(row.process_codes);
  const confirmed = new Set<string>(JSON.parse(row.confirmed));
  const rejected = new Set<string>(JSON.parse(row.rejected));
  if (ok) {
    if (!codes.includes(code)) codes.push(code);
    confirmed.add(code);
    rejected.delete(code);
  } else {
    codes = codes.filter((c) => c !== code);
    confirmed.delete(code);
    rejected.add(code);
  }
  // Tudo confirmado: a IA não mexe mais. Sem pedido: na próxima rodada ela tenta outro candidato.
  const status = codes.length && codes.every((c) => confirmed.has(c)) ? "confirmado" : codes.length ? row.status : "sem_pedido";
  await run(db, `UPDATE sample_links SET process_codes = ?, confirmed = ?, rejected = ?, status = ?, decided_at = ? WHERE item_id = ?`, [
    JSON.stringify(codes), JSON.stringify([...confirmed]), JSON.stringify([...rejected]), status, nowIso(), itemId,
  ]);
  await insertEvents(db, [{
    process_code: code, step_key: "amostra", type: "amostra_monday", actor: user,
    message: `${row.name}: ${ok ? "confirmada como amostra deste pedido" : "não é amostra deste pedido"}`,
  }]);
}
