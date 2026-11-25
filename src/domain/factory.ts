import type { DB, Env } from "../env";
import { all, nowIso, one, run, todayBR, upsertJson } from "../db/q";
import { itemKey, slugsOf } from "../shared/labels";
import { updateStep } from "./actions";
import { loadViews } from "./view";

// Cadastro e presença no site de cada item dos pedidos acompanhados.
// - Fábrica (factory): é onde nasce o slug quando o produto é cadastrado, um material por aparelho
//   ("Case Bold Magsafe Preto / iPhone 18 Pro" = boldmagsafepreto-iphone18pro). Também dá o saldo em Extrema.
// - Site (Spree): o produto está na loja quando a combinação modelo × aparelho existe (spree_case_devices,
//   slug = código do modelo + "-" + código do aparelho) e o estoque do site está ativo
//   (spree_universal_material_stocks, loja Brasil). Versões NFC e B2B não aparecem na loja.
// O GoDeploy só deixa ler essas bases com o login de quem está usando o app (data proxy), então a
// leitura acontece quando alguém abre o Freeway, no máximo a cada 30 minutos, e fica guardada.

const EVERY_MS = 30 * 60_000;
const RETRY_MS = 10 * 60_000;
const EXTREMA = 11;
const STORE_BR = 1;
const CHUNK = 40;
const MAX_AUTO = 20;
export const FACTORY_ACTOR = "Fábrica (automático)";

interface Material {
  id: number;
  slug: string | null;
  name: string | null;
  reference: string | null;
  beepable_code: string | null;
  created_at: string | null;
  archived: boolean | null;
  deleted_at: string | null;
}

/** Um aparelho do item (ou o próprio produto, quando não é capa): material, saldo em Extrema e site. */
export interface FactoryPart {
  label: string;
  slug: string | null;
  created_at: string | null;
  extrema: number;
  /** null = site não consultado. */
  site: boolean | null;
  why: string | null;
}

class ProxyError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function proxyGet(env: Env, cookie: string, db: "factory" | "site", table: string, query: string): Promise<any[]> {
  const res = await fetch(`${env.PROXY_BASE_URL}/${db}/public.${table}?${query}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new ProxyError(res.status, `data proxy ${res.status} em ${db}.${table}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Lista para o filtro `in.(...)` do PostgREST, com aspas (nomes têm vírgulas, barras e parênteses). */
const inList = (vals: (string | number)[]) =>
  encodeURIComponent(`in.(${vals.map((v) => (typeof v === "number" ? String(v) : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")})`);

async function chunked<T>(vals: (string | number)[], size: number, fn: (part: (string | number)[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < vals.length; i += size) out.push(...(await fn(vals.slice(i, i + size))));
  return out;
}

const MAT_COLS = "select=id,slug,name,reference,beepable_code,created_at,archived,deleted_at";
const materialsBy = (env: Env, cookie: string, col: string, vals: string[]) =>
  chunked<Material>(vals, CHUNK, (part) => proxyGet(env, cookie, "factory", "materials", `${MAT_COLS}&${col}=${inList(part)}`));

/** Materiais cujo nome começa com algum dos produtos ("Case Bold Magsafe Açaí*"), em lotes. */
function materialsByPrefix(env: Env, cookie: string, products: string[]): Promise<Material[]> {
  const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}*"`;
  return chunked<Material>(products, 15, (part) =>
    proxyGet(env, cookie, "factory", "materials", `${MAT_COLS}&or=${encodeURIComponent(`(${part.map((p) => `name.ilike.${quote(String(p))}`).join(",")})`)}`),
  );
}

const active = (m: Material) => !m.deleted_at && !m.archived;
/** Versões NFC e B2B são do mesmo produto, mas não aparecem na loja. */
const variant = (m: Material) => /-(nfc|b2b)$/i.test(m.slug ?? "") || /\s-\s*(nfc|b2b)\s*$/i.test(m.name ?? "");
const low = (s: string) => s.trim().toLowerCase();
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const BRAND = /^(iphone|ipad|samsung|galaxy|motorola|moto|xiaomi|redmi|poco|pixel)\b/i;

/**
 * Separa o produto dos aparelhos: "Case Bold Magsafe Açaí - iPhone 17 Pro / 18 Pro" →
 * { product: "Case Bold Magsafe Açaí", devices: ["iphone17pro", "iphone18pro"], labels: ["iPhone 17 Pro", "iPhone 18 Pro"] }.
 * O aparelho sem marca herda a do anterior ("18 Pro" → "iPhone 18 Pro"); " - NFC" e " - B2B" saem.
 */
export function splitDevice(name: string): { product: string; devices: string[]; labels: string[] } | null {
  const m = name.match(/^(.*?)\s*[-/]\s*((?:iphone|ipad|samsung|galaxy|motorola|moto|xiaomi|redmi|poco|pixel)\b.*)$/i);
  if (!m || !m[1].trim()) return null;
  const parts = m[2].replace(/\s+-\s+(nfc|b2b|manual)\s*$/i, "").split("/").map((s) => s.trim()).filter(Boolean);
  let prefix = "";
  const labels = parts.map((p) => {
    if (BRAND.test(p)) {
      const words = p.split(/\s+/);
      const cut = words.findIndex((w) => /\d/.test(w));
      prefix = (cut > 0 ? words.slice(0, cut) : words.slice(0, 1)).join(" ");
      return p;
    }
    return `${prefix} ${p}`;
  });
  return { product: m[1].trim(), devices: labels.map(norm), labels };
}

/** Presença no site de cada slug: combinação modelo × aparelho configurada e estoque do site ativo. */
async function siteStatus(env: Env, cookie: string, slugs: string[]): Promise<Map<string, { site: boolean; why: string | null }>> {
  const out = new Map<string, { site: boolean; why: string | null }>();
  if (!slugs.length) return out;
  const stock = new Map(
    (await chunked<any>(slugs, CHUNK, (part) =>
      proxyGet(env, cookie, "site", "spree_universal_material_stocks", `select=material,in_stock,should_lock&store_id=eq.${STORE_BR}&material=${inList(part)}`),
    )).map((r) => [r.material as string, r]),
  );
  // Slug = código do modelo + "-" + código do aparelho; testa cada ponto de corte.
  const splits = slugs.flatMap((s) => [...s.matchAll(/-/g)].map((m) => ({ slug: s, ct: s.slice(0, m.index), dev: s.slice(m.index! + 1) })));
  const [types, devices] = await Promise.all([
    chunked<any>([...new Set(splits.map((x) => x.ct))], CHUNK, (part) => proxyGet(env, cookie, "site", "spree_case_types", `select=id,code&code=${inList(part)}`)),
    chunked<any>([...new Set(splits.map((x) => x.dev))], CHUNK, (part) => proxyGet(env, cookie, "site", "spree_devices", `select=id,code&code=${inList(part)}`)),
  ]);
  const typeId = new Map(types.map((t) => [t.code as string, t.id as number]));
  const devId = new Map(devices.map((d) => [d.code as string, d.id as number]));
  const valid = splits.filter((x) => typeId.has(x.ct) && devId.has(x.dev));
  const combos = new Set<string>();
  if (valid.length) {
    const tIds = [...new Set(valid.map((x) => typeId.get(x.ct)!))];
    const dIds = [...new Set(valid.map((x) => devId.get(x.dev)!))];
    for (let i = 0; i < tIds.length; i += 60) {
      const rows = await chunked<any>(dIds, 60, (dPart) =>
        proxyGet(env, cookie, "site", "spree_case_devices", `select=case_type_id,device_id&deleted_at=is.null&case_type_id=${inList(tIds.slice(i, i + 60))}&device_id=${inList(dPart)}`),
      );
      for (const r of rows) combos.add(`${r.case_type_id}|${r.device_id}`);
    }
  }
  for (const s of slugs) {
    const mine = valid.filter((x) => x.slug === s);
    // Sem modelo e aparelho conhecidos (brindes, peças), vale só o estoque do site.
    const hasModel = !mine.length || mine.some((x) => combos.has(`${typeId.get(x.ct)}|${devId.get(x.dev)}`));
    const st = stock.get(s);
    if (!hasModel) out.set(s, { site: false, why: "modelo × aparelho ainda não configurado no site" });
    else if (!st) out.set(s, { site: false, why: "sem estoque cadastrado no site" });
    else if (st.should_lock) out.set(s, { site: false, why: "travado no site" });
    else if (!st.in_stock) out.set(s, { site: false, why: "sem estoque no site" });
    else out.set(s, { site: true, why: null });
  }
  return out;
}

/** Lê a fábrica e o site para os itens dos pedidos acompanhados e guarda o resultado de cada um. */
export async function refreshFactory(db: DB, env: Env, cookie: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const watched = `SELECT DISTINCT process_code FROM watchers`;
  const rows = await all<{ code: string | null; name: string | null }>(
    db,
    `SELECT DISTINCT sku_code AS code, sku AS name FROM order_items WHERE removed_at IS NULL AND process_code IN (${watched})
     UNION SELECT DISTINCT sku_code, sku FROM shipment_items WHERE removed_at IS NULL AND process_code IN (${watched})`,
  );
  const items = new Map<string, { code: string | null; name: string | null }>();
  for (const r of rows) {
    const k = itemKey(r.code, r.name);
    if (k && !items.has(k)) items.set(k, r);
  }
  const codes = [...new Set(rows.map((r) => r.code?.trim().toUpperCase()).filter(Boolean) as string[])];
  const prods = codes.length ? await all(db, `SELECT base_code, sku_unico, factory FROM product_codes WHERE base_code IN (SELECT value FROM json_each(?))`, [JSON.stringify(codes)]) : [];
  const prodBy = new Map(prods.map((p) => [p.base_code as string, p]));

  // Candidatos de cada item: slugs da planilha de produtos, código WMS na etiqueta (beepable_code = código + QR),
  // nomes e, para capas, o produto e os aparelhos ("Case Bold Magsafe Açaí" + iPhone 17 Pro e iPhone 18 Pro).
  const cand = new Map<string, { slugs: string[]; beep: string | null; names: string[]; split: ReturnType<typeof splitDevice> }>();
  for (const [k, it] of items) {
    const code = it.code?.trim().toUpperCase() || null;
    const p = code ? prodBy.get(code) : undefined;
    const names = [...new Set([it.name, p?.sku_unico].filter((s): s is string => !!s && !!s.trim()).map((s) => s.trim()))];
    cand.set(k, { slugs: slugsOf(p?.factory), beep: code ? `${code}QR` : null, names, split: names.map(splitDevice).find(Boolean) ?? null });
  }
  const uniq = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined && x !== ""))];
  const all_ = [...cand.values()];
  const [bySlug, byBeep, byPrefix] = await Promise.all([
    materialsBy(env, cookie, "slug", uniq(all_.flatMap((c) => c.slugs))),
    materialsBy(env, cookie, "beepable_code", uniq(all_.map((c) => c.beep))),
    materialsByPrefix(env, cookie, uniq(all_.map((c) => c.split?.product))),
  ]);
  const plainNames = uniq(all_.filter((c) => !c.split).flatMap((c) => c.names));
  const [byRef, byName] = plainNames.length ? await Promise.all([materialsBy(env, cookie, "reference", plainNames), materialsBy(env, cookie, "name", plainNames)]) : [[], []];
  const slugIdx = new Map(bySlug.map((m) => [m.slug!, m]));
  const beepIdx = new Map(byBeep.map((m) => [m.beepable_code!, m]));
  const nameIdx = new Map<string, Material[]>();
  for (const m of [...byRef, ...byName]) for (const n of [m.reference, m.name]) if (n) nameIdx.set(low(n), [...(nameIdx.get(low(n)) ?? []), m]);
  const prefixIdx = new Map<string, Material[]>();
  for (const m of byPrefix) {
    const s = splitDevice(m.name ?? "");
    if (s) prefixIdx.set(norm(s.product), [...(prefixIdx.get(norm(s.product)) ?? []), m]);
  }
  // Prefere o material ativo e sem ser versão NFC/B2B.
  const best = (ms: (Material | undefined)[]) => {
    const list = ms.filter((m): m is Material => !!m);
    return list.find((m) => active(m) && !variant(m)) ?? list.find((m) => !variant(m)) ?? null;
  };

  // Alvos de cada item: um por aparelho (capas) ou o próprio produto.
  const targets = new Map<string, { label: string; m: Material | null }[]>();
  for (const [k, c] of cand) {
    const known = [...c.slugs.map((s) => slugIdx.get(s)), c.beep ? beepIdx.get(c.beep) : undefined].filter((m): m is Material => !!m);
    if (c.split) {
      const pool = [...(prefixIdx.get(norm(c.split.product)) ?? []), ...known];
      targets.set(k, c.split.devices.map((d, i) => ({ label: c.split!.labels[i], m: best(pool.filter((m) => splitDevice(m.name ?? "")?.devices.includes(d))) })));
    } else {
      targets.set(k, [{ label: c.names[0] ?? k, m: best([...known, ...c.names.flatMap((n) => nameIdx.get(low(n)) ?? [])]) }]);
    }
  }

  // Saldo em Extrema (centro 11; "ready" já desconta a margem de segurança) e presença no site.
  const mats = [...targets.values()].flatMap((ts) => ts.map((t) => t.m)).filter((m): m is Material => !!m);
  const stock = new Map<number, number>();
  for (const s of await chunked<any>(uniq(mats.map((m) => m.id)), 80, (part) =>
    proxyGet(env, cookie, "factory", "supplies", `select=suppliable_id,ready&suppliable_type=eq.Material&inventory_centre_id=eq.${EXTREMA}&deleted_at=is.null&suppliable_id=${inList(part)}`),
  )) stock.set(s.suppliable_id, Math.max(stock.get(s.suppliable_id) ?? 0, Number(s.ready) || 0));
  let site = new Map<string, { site: boolean; why: string | null }>();
  let siteErr: string | null = null;
  try {
    site = await siteStatus(env, cookie, uniq(mats.filter(active).map((m) => m.slug)));
  } catch (err) {
    siteErr = (err as Error).message;
  }

  const prev = new Map((await all<{ item_key: string; live_since: string | null }>(db, `SELECT item_key, live_since FROM factory_items`)).map((r) => [r.item_key, r.live_since]));
  const now = nowIso();
  const today = todayBR();
  let reg = 0;
  let live = 0;
  const out = [...items.keys()].map((k) => {
    const parts: FactoryPart[] = targets.get(k)!.map(({ label, m }) => {
      const ok = !!m && active(m);
      const st = ok && m!.slug ? site.get(m!.slug) : undefined;
      return {
        label,
        slug: ok ? m!.slug : null,
        created_at: ok ? m!.created_at?.slice(0, 10) ?? null : null,
        extrema: ok ? stock.get(m!.id) ?? 0 : 0,
        site: ok ? (siteErr ? null : st?.site ?? false) : false,
        why: !m ? "sem cadastro na fábrica" : !ok ? "arquivado na fábrica" : st?.why ?? null,
      };
    });
    const n = parts.length;
    const regCount = parts.filter((p) => p.slug).length;
    const siteCount = parts.filter((p) => p.site).length;
    if (regCount === n) reg++;
    if (n && siteCount === n) live++;
    return {
      item_key: k,
      material_id: targets.get(k)!.find((t) => t.m)?.m?.id ?? null,
      slug: parts.map((p) => p.slug).filter(Boolean).join(", ") || null,
      name: targets.get(k)!.find((t) => t.m)?.m?.name ?? null,
      via: cand.get(k)!.split ? "aparelho" : "produto",
      created_at: parts.map((p) => p.created_at).filter(Boolean).sort().pop() ?? null,
      active: regCount === n && n ? 1 : 0,
      extrema_ready: parts.reduce((a, p) => a + p.extrema, 0),
      extrema_total: null,
      parts: JSON.stringify(parts),
      n_targets: n,
      reg_count: regCount,
      site_count: siteCount,
      site_checked: siteErr ? 0 : 1,
      // Primeira vez que o Freeway viu o item no site (todos os aparelhos).
      live_since: prev.get(k) ?? (n && siteCount === n ? today : null),
      checked_at: now,
    };
  });
  await upsertJson(
    db,
    "factory_items",
    ["item_key", "material_id", "slug", "name", "via", "created_at", "active", "extrema_ready", "extrema_total", "parts", "n_targets", "reg_count", "site_count", "site_checked", "live_since", "checked_at"],
    ["item_key"],
    out,
  );
  const lancados = await autoLaunch(db);
  return { itens: items.size, cadastrados: reg, no_site: live, site: siteErr ?? "ok", lancados, ms: Date.now() - t0 };
}

/**
 * Grava o lançamento dos fretes que a visão já mostra como no ar (todos os itens no site e, se o
 * pedido tem alinhamento de matriz, alinhamento feito). Assim fica a data, o aviso e o pedido sai
 * da lista dos em andamento. Quem reabrir à mão é respeitado.
 */
export async function autoLaunch(db: DB): Promise<number> {
  const codes = (await all<{ process_code: string }>(db, `SELECT DISTINCT process_code FROM watchers`)).map((r) => r.process_code);
  const views = await loadViews(db, codes);
  let n = 0;
  for (const v of views) {
    for (const u of v.units) {
      if (n >= MAX_AUTO) return n;
      const st = u.steps.find((s) => s.key === "lancamento");
      if (!st || st.status !== "done" || st.source !== "fabrica") continue;
      await updateStep(db, u.unit, "lancamento", { done_at: todayBR(), auto_at: todayBR() }, FACTORY_ACTOR);
      n++;
    }
  }
  return n;
}

/** Lê fábrica e site se a última leitura tem mais de 30 minutos. Usa o login de quem está abrindo o app. */
export async function maybeRefreshFactory(db: DB, env: Env, cookie: string | null, force = false): Promise<Record<string, unknown> | null> {
  if (!env.PROXY_BASE_URL || !cookie) return null;
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'factory_sync'`);
  const st = row ? JSON.parse(row.value) : {};
  const now = Date.now();
  if (!force && st.next && now < Date.parse(st.next)) return null;
  const save = (v: Record<string, unknown>) =>
    run(db, `INSERT INTO settings (key, value) VALUES ('factory_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(v)]);
  // Marca antes de ler, para duas visitas ao mesmo tempo não lerem em dobro.
  await save({ ...st, next: new Date(now + RETRY_MS).toISOString() });
  try {
    const out = await refreshFactory(db, env, cookie);
    await save({ at: nowIso(), next: new Date(now + EVERY_MS).toISOString(), ...out });
    console.log(`[fabrica] ${JSON.stringify(out)}`);
    return out;
  } catch (err) {
    // 401/403: quem abriu o app não tem acesso à base; tenta de novo com a próxima visita.
    const msg = (err as Error).message;
    console.log(`[fabrica] falhou: ${msg}`);
    await save({ ...st, next: new Date(now + RETRY_MS).toISOString(), erro: msg, erro_at: nowIso() });
    return { erro: msg };
  }
}
