import type { DB, Env } from "../env";
import { all, nowIso, upsertJson } from "../db/q";
import { allFolders, children, driveAuth, driveConfigured, isFolder, sharedDrives, sharedWithMe, type DriveFile } from "../integrations/drive";
import { updateStep } from "./actions";

// Documentação pronta = os PDFs de barcodes e de carton marks gerados pelo FileMaker na pasta do pedido.
const REQUIRED = [/barcode/i, /carton\s*marks?/i];
const CODE = /\b(GOC|BBI)\s?-?\s?(\d{5})/i;
const MAX_DEPTH = 4;
// Limite de pastas abertas por rodada, para a rotina não crescer sem controle.
const MAX_OPEN = 300;

const brDate = (iso: string) => new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(0, 10);
const line = (f: DriveFile) => `${isFolder(f) ? "[pasta] " : ""}${f.name}${f.modifiedTime ? ` (${f.modifiedTime.slice(0, 10)})` : ""}`;

/** Código do pedido no nome da pasta: "BBI25277 - YNS"; sem prefixo ("25277 - YNS") só se só existir um pedido com o número. */
function codeOf(name: string, known: Set<string>): string | null {
  const m = name.match(CODE);
  if (m) {
    const code = `${m[1].toUpperCase()}${m[2]}`;
    return known.has(code) ? code : null;
  }
  const n = name.match(/(?:^|\D)(\d{5})(?:\D|$)/)?.[1];
  if (!n) return null;
  const hits = [`BBI${n}`, `GOC${n}`].filter((c) => known.has(c));
  return hits.length === 1 ? hits[0] : null;
}

interface Root {
  id: string;
  name: string;
  driveId?: string;
}

/**
 * Documentação do pedido no Drive: acha a pasta de cada pedido dentro das
 * pastas do FileMaker que a conta de serviço enxerga e guarda o link em
 * order_docs. Abre as pastas uma a uma a partir das raízes (Drives
 * compartilhados, pastas compartilhadas e pastas cujo pai ela não enxerga),
 * porque a busca geral do Drive pode voltar incompleta. As pastas da "Pasta
 * Arquivos" da planilha (documentação de importação) ficam de fora.
 */
export async function refreshDocs(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!driveConfigured(env)) return { skipped: "conta de serviço não configurada" };
  const auth = await driveAuth(env);
  const [drives, shared, searched] = await Promise.all([sharedDrives(auth), sharedWithMe(auth), allFolders(auth)]);
  const visible = new Set(searched.map((f) => f.id));
  const roots = new Map<string, Root>();
  for (const d of drives) roots.set(d.id, { id: d.id, name: d.name, driveId: d.id });
  for (const f of shared) roots.set(f.id, { id: f.id, name: f.name, driveId: f.driveId });
  for (const f of searched) if (!(f.parents ?? []).some((p) => visible.has(p))) roots.set(f.id, { id: f.id, name: f.name, driveId: f.driveId });

  const orders = await all<{ process_code: string; files_url: string | null }>(db, `SELECT process_code, files_url FROM orders`);
  const known = new Set(orders.map((r) => r.process_code));
  const importFolders = new Set(orders.map((o) => o.files_url?.match(/folders\/([\w-]+)/)?.[1]).filter(Boolean) as string[]);

  const found = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  const firstLevel: string[] = [];
  let opened = 0;
  // Fila: [pasta, caminho, profundidade]. A pasta com o código é a do pedido: não desce nela.
  const queue: [Root, string, number][] = [...roots.values()].map((r) => [r, r.name, 0]);
  while (queue.length && opened < MAX_OPEN) {
    const [f, path, depth] = queue.shift()!;
    if (seen.has(f.id) || importFolders.has(f.id)) continue;
    seen.add(f.id);
    const code = codeOf(f.name, known);
    if (code) {
      if (!found.has(code)) {
        found.set(code, { process_code: code, folder_id: f.id, folder_name: f.name, link: `https://drive.google.com/drive/folders/${f.id}`, path, drive_id: f.driveId ?? null, checked_at: nowIso() });
      }
      continue;
    }
    if (depth >= MAX_DEPTH) continue;
    opened++;
    const kids = await children(auth, f.id, { driveId: f.driveId, foldersOnly: true });
    if (depth === 0) firstLevel.push(...kids.slice(0, 8).map((k) => k.name));
    for (const k of kids) queue.push([{ id: k.id, name: k.name, driveId: k.driveId ?? f.driveId }, `${path} / ${k.name}`, depth + 1]);
  }

  await upsertJson(db, "order_docs", ["process_code", "folder_id", "folder_name", "link", "path", "drive_id", "checked_at"], ["process_code"], [...found.values()]);
  console.log(
    `[docs] drives: ${drives.map((d) => d.name).join(", ") || "nenhum"} · compartilhadas: ${shared.map((f) => f.name).join(", ") || "nenhuma"} · ` +
      `raízes: ${[...roots.values()].slice(0, 15).map((r) => r.name).join(", ")} · ${opened} pastas abertas · ${found.size} pedidos com pasta · ` +
      `exemplos no 1º nível: ${firstLevel.slice(0, 15).join(" ; ")}`,
  );

  // Marca a documentação como pronta nos pedidos que ainda não têm a marcação e já têm os dois PDFs.
  const pending = await all<{ process_code: string; folder_id: string; drive_id: string | null }>(
    db,
    `SELECT d.process_code, d.folder_id, d.drive_id FROM order_docs d
      WHERE NOT EXISTS (SELECT 1 FROM step_state ss WHERE ss.scope = d.process_code AND ss.step_key = 'producao'
                          AND json_extract(ss.data, '$.docs_done_at') IS NOT NULL)
      LIMIT 30`,
  );
  let marked = 0;
  for (const p of pending) {
    const files = (await children(auth, p.folder_id, { driveId: p.drive_id ?? undefined, max: 200 })).filter((f) => !isFolder(f));
    const hits = REQUIRED.map((re) => files.find((f) => re.test(f.name)));
    if (hits.some((h) => !h)) {
      console.log(`[docs] ${p.process_code}: falta ${REQUIRED.filter((_, i) => !hits[i]).map((re) => re.source).join(" e ")} · ${files.map(line).join(" ; ")}`);
      continue;
    }
    const when = hits.map((h) => h!.modifiedTime ?? nowIso()).sort().at(-1)!;
    await updateStep(db, p.process_code, "producao", { docs_done_at: brDate(when) }, "Drive (FileMaker)");
    marked++;
  }
  return { drives: drives.length, roots: roots.size, opened, orders: found.size, marked };
}
