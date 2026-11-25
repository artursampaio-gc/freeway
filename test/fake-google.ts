// Simula o Google (token da conta de serviço e Drive) nos testes locais.
// Monta um Drive compartilhado "FileMaker" com a pasta do pedido dentro de
// uma pasta por ano, e uma busca geral incompleta (como acontece de verdade).
export interface FakeFolder {
  id: string;
  name: string;
  parent: string;
  files?: string[];
}

export async function fakeServiceAccountKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`;
}

export function installFakeGoogle(drive: { id: string; name: string }, folders: FakeFolder[], searchFinds: string[], sheets: Record<string, unknown[][]> = {}) {
  const realFetch = globalThis.fetch;
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  const asFile = (f: FakeFolder) => ({ id: f.id, name: f.name, mimeType: "application/vnd.google-apps.folder", parents: [f.parent], driveId: drive.id });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "oauth2.googleapis.com") return json({ access_token: "fake" });
    if (url.host === "sheets.googleapis.com" && Object.keys(sheets).length) {
      // Planilha: devolve a grade de cada aba pedida ("'Aba'!A1:AL").
      return json({ valueRanges: url.searchParams.getAll("ranges").map((r) => {
        const tab = r.split("!")[0].replace(/^'|'$/g, "");
        return { range: r, values: sheets[tab] ?? [] };
      }) });
    }
    if (url.host !== "www.googleapis.com" || !url.pathname.startsWith("/drive/v3/")) return realFetch(input, init);
    if (url.pathname === "/drive/v3/drives") return json({ drives: [drive] });
    const q = url.searchParams.get("q") ?? "";
    if (q.startsWith("sharedWithMe")) return json({ files: [] });
    const parent = q.match(/^'([^']+)' in parents/)?.[1];
    if (!parent) return json({ files: folders.filter((f) => searchFinds.includes(f.id)).map(asFile), incompleteSearch: true });
    const sub = folders.filter((f) => f.parent === parent).map(asFile);
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) return json({ files: sub });
    const files = (folders.find((f) => f.id === parent)?.files ?? []).map((name, i) => ({ id: `${parent}-${i}`, name, mimeType: "application/pdf", modifiedTime: "2026-10-28T15:00:00Z" }));
    return json({ files: [...sub, ...files] });
  }) as typeof fetch;
}
