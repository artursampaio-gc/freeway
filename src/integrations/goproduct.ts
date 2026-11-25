import type { Env } from "../env";

// GoProduct: catálogo de produtos (InvenTree 1.x, interface em /web). A API e as imagens
// exigem login; o Freeway usa o token de API do secret GOPRODUCT_TOKEN.
export const GOPRODUCT_BASE = "https://goproduct.gogroupbr.com";

export function goproductConfigured(env: Env): boolean {
  return !!env.GOPRODUCT_TOKEN;
}

const auth = (env: Env) => ({ Authorization: `Token ${env.GOPRODUCT_TOKEN}` });

export interface GpPart {
  pk: number;
  IPN: string | null;
  name: string;
  thumbnail: string | null;
  image: string | null;
  active: boolean;
  /** Cor do cadastro (nome em português e hexadecimal), quando a API manda. */
  cor: string | null;
  cor_hex: string | null;
  /** Número da cor no cadastro (para saber se só faltou o detalhe). */
  cor_id?: number | null;
  cor_en?: string | null;
}

/** Hexadecimal da cor, sem o vermelho provisório que o cadastro usa enquanto não tem o Pantone. */
function realHex(d: any): string | null {
  const hex = typeof d?.hex_code === "string" ? d.hex_code.toLowerCase() : null;
  if (!hex) return null;
  const placeholder = (d.pantones ?? []).some((p: any) => /place\s*holder/i.test(String(p?.codigo ?? "")));
  return placeholder && (hex === "#ff0000" || (d.pantones ?? []).every((p: any) => /place\s*holder/i.test(String(p?.codigo ?? "")))) ? null : hex;
}

export interface GpColor {
  pk: number;
  nome_pt: string | null;
  nome_en: string | null;
  hex: string | null;
  /** Hexadecimal de cada pantone da cor, na ordem do cadastro (cor composta tem mais de um). */
  pantones: string[];
  /** Imagem da textura (estampa), quando a cor é uma textura. */
  textura: string | null;
}

/** Catálogo de cores do GoProduct (part/cor/), em páginas de 200, sem os pantones provisórios. */
export async function gpColors(env: Env): Promise<GpColor[]> {
  const out: GpColor[] = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const res = await fetch(`${GOPRODUCT_BASE}/api/part/cor/?limit=200&offset=${offset}`, { headers: { ...auth(env), Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GoProduct cores ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const rows: any[] = json.results ?? (Array.isArray(json) ? json : []);
    for (const r of rows) {
      const pantones = (Array.isArray(r.pantones) ? r.pantones : [])
        .filter((p: any) => !/place\s*holder/i.test(String(p?.codigo ?? "")) && /^#[0-9a-f]{6}$/i.test(String(p?.hex_code ?? "")))
        .map((p: any) => String(p.hex_code).toLowerCase());
      out.push({ pk: r.pk, nome_pt: r.nome_pt || null, nome_en: r.nome_en || null, hex: realHex(r), pantones, textura: typeof r.textura_url === "string" && r.textura_url ? r.textura_url : null });
    }
    if (!json.next || rows.length === 0) break;
  }
  return out;
}

/** Todos os produtos (pk, IPN, nome e imagens), em páginas de 200. */
export async function gpParts(env: Env): Promise<GpPart[]> {
  const out: GpPart[] = [];
  for (let offset = 0; offset < 20_000; offset += 200) {
    const res = await fetch(`${GOPRODUCT_BASE}/api/part/?limit=200&offset=${offset}&cor_detail=true`, { headers: { ...auth(env), Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GoProduct ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const rows: any[] = json.results ?? (Array.isArray(json) ? json : []);
    for (const r of rows) {
      out.push({
        pk: r.pk, IPN: r.IPN || null, name: r.name, thumbnail: r.thumbnail || null, image: r.image || null, active: r.active !== false,
        cor: r.cor_detail?.nome_pt || null, cor_hex: realHex(r.cor_detail), cor_id: typeof r.cor === "number" ? r.cor : null, cor_en: r.cor_detail?.nome_en || null,
      });
    }
    if (!json.next || rows.length === 0) break;
  }
  return out;
}

/** Baixa uma imagem do GoProduct (caminho /media/... da API). */
export async function gpImage(env: Env, path: string): Promise<{ type: string; bytes: Uint8Array }> {
  const url = path.startsWith("http") ? path : `${GOPRODUCT_BASE}${path}`;
  const res = await fetch(url, { headers: auth(env), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GoProduct imagem ${res.status}`);
  return { type: res.headers.get("Content-Type") ?? "image/png", bytes: new Uint8Array(await res.arrayBuffer()) };
}
