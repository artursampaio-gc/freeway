import type { DB, Env } from "../env";
import { all, nowIso, one, run, upsertJson } from "../db/q";
import { GOPRODUCT_BASE, goproductConfigured, gpColors, gpImage, gpParts } from "../integrations/goproduct";

// Catálogo do GoProduct lido uma vez por dia: dá o link (pk) e a miniatura de cada produto pelo
// IPN, que é o código WMS do item (UV503247). As miniaturas ficam guardadas no banco, porque o
// GoProduct só entrega imagem com login e o navegador de quem usa o Freeway não tem esse login.

const MAX_IMAGE = 400_000;

export async function refreshGoProduct(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!goproductConfigured(env)) return { skipped: "GOPRODUCT_TOKEN não configurado" };
  const t0 = Date.now();
  const parts = await gpParts(env);
  const prev = new Map((await all<{ pk: number; thumbnail: string | null }>(db, `SELECT pk, thumbnail FROM goproduct_parts`)).map((r) => [r.pk, r.thumbnail]));
  const rows = parts.map((p) => ({ pk: p.pk, ipn: p.IPN?.trim().toUpperCase() || null, name: p.name, thumbnail: p.thumbnail, active: p.active ? 1 : 0, cor: p.cor, cor_hex: p.cor_hex, updated_at: nowIso() }));
  await upsertJson(db, "goproduct_parts", ["pk", "ipn", "name", "thumbnail", "active", "cor", "cor_hex", "updated_at"], ["pk"], rows);
  const colors = new Map<number, { pk: number; nome_pt: string | null; nome_en: string | null; hex: string | null; updated_at: string }>();
  for (const p of parts) if (p.cor_id && p.cor && !colors.has(p.cor_id)) colors.set(p.cor_id, { pk: p.cor_id, nome_pt: p.cor, nome_en: p.cor_en ?? null, hex: p.cor_hex, updated_at: nowIso() });
  if (colors.size) await upsertJson(db, "goproduct_colors", ["pk", "nome_pt", "nome_en", "hex", "updated_at"], ["pk"], [...colors.values()]);
  const keep = new Set(parts.map((p) => p.pk));
  const gone = [...prev.keys()].filter((pk) => !keep.has(pk));
  if (gone.length) await run(db, `DELETE FROM goproduct_parts WHERE pk IN (SELECT value FROM json_each(?))`, [JSON.stringify(gone)]);
  // Imagem trocada no GoProduct: a guardada sai e é baixada de novo na próxima visita.
  const changed = rows.filter((r) => prev.has(r.pk) && prev.get(r.pk) !== r.thumbnail).map((r) => r.pk);
  if (changed.length || gone.length) await run(db, `DELETE FROM goproduct_images WHERE pk IN (SELECT value FROM json_each(?))`, [JSON.stringify([...changed, ...gone])]);
  return { produtos: parts.length, com_imagem: parts.filter((p) => p.thumbnail).length, com_cor: parts.filter((p) => p.cor).length, cores: colors.size, cor_sem_nome: parts.filter((p) => p.cor_id && !p.cor).length, removidos: gone.length, imagens_trocadas: changed.length, ms: Date.now() - t0 };
}

const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Miniatura do produto: do banco, ou baixada do GoProduct e guardada. */
export async function goproductThumb(db: DB, env: Env, pk: number): Promise<{ type: string; bytes: Uint8Array } | null> {
  const cached = await one<{ content_type: string; data: string }>(db, `SELECT content_type, data FROM goproduct_images WHERE pk = ?`, [pk]);
  if (cached) return cached.data ? { type: cached.content_type, bytes: fromB64(cached.data) } : null;
  const part = await one<{ thumbnail: string | null }>(db, `SELECT thumbnail FROM goproduct_parts WHERE pk = ?`, [pk]);
  if (!part?.thumbnail || !goproductConfigured(env)) return null;
  const img = await gpImage(env, part.thumbnail);
  const ok = img.type.startsWith("image/") && img.bytes.length <= MAX_IMAGE;
  // Guarda também a falta de imagem (data vazio), para não tentar de novo a cada visita.
  await run(db, `INSERT INTO goproduct_images (pk, content_type, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(pk) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, fetched_at = excluded.fetched_at`, [
    pk, img.type, ok ? toB64(img.bytes) : "", nowIso(),
  ]);
  return ok ? img : null;
}

// ---------- Cores (catálogo part/cor/) ----------

const COLORS_TTL_MS = 12 * 3600 * 1000;
const MAX_TEXTURE = 1_000_000;

/** Relê o catálogo de cores: nome, hexadecimal, todos os pantones e a textura. A textura trocada sai do cache. */
export async function refreshGoProductColors(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!goproductConfigured(env)) return { skipped: "GOPRODUCT_TOKEN não configurado" };
  const colors = await gpColors(env);
  const prev = new Map((await all<{ pk: number; textura: string | null }>(db, `SELECT pk, textura FROM goproduct_colors`)).map((r) => [r.pk, r.textura]));
  const now = nowIso();
  await upsertJson(db, "goproduct_colors", ["pk", "nome_pt", "nome_en", "hex", "pantones", "textura", "updated_at"], ["pk"], colors.map((c) => ({ ...c, pantones: JSON.stringify(c.pantones), updated_at: now })));
  const changed = colors.filter((c) => prev.has(c.pk) && prev.get(c.pk) !== c.textura).map((c) => c.pk);
  if (changed.length) await run(db, `DELETE FROM goproduct_textures WHERE pk IN (SELECT value FROM json_each(?))`, [JSON.stringify(changed)]);
  await run(db, `INSERT INTO settings (key, value) VALUES ('goproduct_colors_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(now)]);
  return { cores: colors.length, compostas: colors.filter((c) => c.pantones.length > 1).length, texturas: colors.filter((c) => c.textura).length, texturas_trocadas: changed.length };
}

/** Na rotina de hora em hora: relê as cores se a última leitura tiver mais de 12 h (ou nunca tiver acontecido). */
export async function maybeRefreshColors(db: DB, env: Env): Promise<Record<string, unknown> | null> {
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'goproduct_colors_at'`);
  const at = row ? Date.parse(JSON.parse(row.value)) : 0;
  if (Date.now() - at < COLORS_TTL_MS) return null;
  return refreshGoProductColors(db, env);
}

/** Textura de uma cor: do banco, ou baixada do GoProduct (só do próprio GoProduct, com o token) e guardada. */
export async function goproductTexture(db: DB, env: Env, pk: number): Promise<{ type: string; bytes: Uint8Array } | null> {
  const cached = await one<{ content_type: string; data: string }>(db, `SELECT content_type, data FROM goproduct_textures WHERE pk = ?`, [pk]);
  if (cached) return cached.data ? { type: cached.content_type, bytes: fromB64(cached.data) } : null;
  const color = await one<{ textura: string | null }>(db, `SELECT textura FROM goproduct_colors WHERE pk = ?`, [pk]);
  if (!color?.textura || !goproductConfigured(env)) return null;
  let path: string;
  try {
    const u = new URL(color.textura, GOPRODUCT_BASE);
    if (u.origin !== GOPRODUCT_BASE || !u.pathname.startsWith("/media/") || u.pathname.includes("..")) return null;
    path = u.pathname;
  } catch {
    return null;
  }
  const img = await gpImage(env, path);
  const ok = img.type.startsWith("image/") && img.bytes.length <= MAX_TEXTURE;
  await run(db, `INSERT INTO goproduct_textures (pk, url, content_type, data, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pk) DO UPDATE SET url = excluded.url, content_type = excluded.content_type, data = excluded.data, fetched_at = excluded.fetched_at`, [
    pk, color.textura, img.type, ok ? toB64(img.bytes) : "", nowIso(),
  ]);
  return ok ? img : null;
}
