import type { Env } from "../env";

// App de industrialização de Itapeva ("GDI — BB Indústria"), também no GoDeploy.
// Rotas oficiais criadas pelo dono do GDI em 30/10/2026, chamadas com a chave
// gdk_ do secret ITAPEVA_API_KEY. Regras combinadas com ele:
// - fila e volume só com tipo=OP,OPI (OPM agrega, OPF vira OPI: somar tudo conta em dobro);
// - a chave de uma OP é o `id` (UUID), nunca o número, que tem repetidos.
export const ITAPEVA_BASE = "https://gdi.devgogroup.com";

export function itapevaConfigured(env: Env): boolean {
  return !!env.ITAPEVA_API_KEY;
}

export async function gdiGet(env: Env, path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${ITAPEVA_BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${env.ITAPEVA_API_KEY}` },
    redirect: "manual",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GDI ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.ok === false) throw new Error(`GDI: ${text.slice(0, 300)}`);
  return json;
}

/** Ordens de produção (industrialização). Filtros: item, pedido, numero, status, tipo, desde, ate, campo, limite. */
export async function gdiOrdens(env: Env, params: Record<string, string>): Promise<Record<string, any>[]> {
  return (await gdiGet(env, "/api/v1/gdi/ordens", params)).linhas ?? [];
}
