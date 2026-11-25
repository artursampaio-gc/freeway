// Simula as rotas do GDI (Itapeva) nos testes locais.
export const gdiCalls: string[] = [];

export function installFakeGdi() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host !== "gdi.devgogroup.com") return realFetch(input, init);
    gdiCalls.push(`${url.pathname}?${url.searchParams}`);
    const linhas = url.pathname.endsWith("/ordens")
      ? [
          { id: "u1", op_numero: "OPI-20261030-001", item_codigo: "TX221004BR", descricao: "Bolsa Moove Marrom", quantidade: 300, status: "em_producao", canal: "B2C", criado_em: "2026-10-29T12:00:00Z" },
          { id: "u2", op_numero: "OPI-20261028-004", item_codigo: "TX221004BR", descricao: "Bolsa Moove Marrom", quantidade: 200, status: "concluido", canal: "B2C", criado_em: "2026-10-27T12:00:00Z", concluido_em: "2026-10-28T18:00:00Z" },
        ].filter((o) => !url.searchParams.get("status") || url.searchParams.get("status")!.split(",").includes(o.status))
      : [];
    return new Response(JSON.stringify({ ok: true, total: linhas.length, linhas }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
