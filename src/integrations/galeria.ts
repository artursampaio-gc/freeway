import type { Env } from "../env";

// Galeria de Lançamentos (app 9c5a5d2c, lancamentosgocase.devgogroup.com), também no GoDeploy.
// O gateway aceita a chave gdk_ do secret GALERIA_API_KEY no lugar do login, como no GDI de Itapeva.
// A chave é de um administrador da Galeria: o Freeway só faz GET (lançamentos e imagens), nunca grava.
export const GALERIA_BASE = "https://lancamentosgocase.devgogroup.com";

export const galeriaConfigured = (env: Env): boolean => !!env.GALERIA_API_KEY?.trim();

export function galeriaFetch(env: Env, path: string, timeoutMs = 30_000): Promise<Response> {
  return fetch(`${GALERIA_BASE}${path}`, { headers: { Authorization: `Bearer ${env.GALERIA_API_KEY?.trim()}` }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}

/** Todos os lançamentos da Galeria (/api/launches). A Galeria monta a lista na hora e pode levar mais de 30 s. */
export async function galeriaLaunches(env: Env): Promise<Record<string, any>[]> {
  const res = await galeriaFetch(env, "/api/launches", 120_000);
  const text = await res.text();
  if (!res.ok) throw new Error(`Galeria ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  return Array.isArray(json.launches) ? json.launches : [];
}

/**
 * Uma imagem da Galeria (/api/image/<id>). Se a Galeria redirecionar para outro endereço (armazenamento
 * da imagem), segue sem mandar a chave.
 */
export async function galeriaImage(env: Env, id: string, v: string | null): Promise<Response | null> {
  let res = await galeriaFetch(env, `/api/image/${encodeURIComponent(id)}${v ? `?v=${encodeURIComponent(v)}` : ""}`);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) return null;
    const target = new URL(loc, GALERIA_BASE);
    if (target.origin === GALERIA_BASE) res = await galeriaFetch(env, target.pathname + target.search);
    else if (target.protocol === "https:") res = await fetch(target.toString(), { signal: AbortSignal.timeout(30_000) });
    else return null;
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
  return res;
}
