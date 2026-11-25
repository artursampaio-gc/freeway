import type { Env } from "../env";
import { TABS } from "./normalize";
import type { Grid } from "./xlsx";

export function sheetsConfigured(env: Env): boolean {
  return !!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY && env.IMPORT_SHEET_ID);
}

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Token da conta de serviço. A mesma conta lê a planilha e a pasta da documentação no Drive. */
export async function accessToken(env: Env, scope = "https://www.googleapis.com/auth/spreadsheets.readonly"): Promise<string> {
  const pem = env.GOOGLE_SA_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: env.GOOGLE_SA_EMAIL,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Lê faixas de uma planilha pela Sheets API, com valores crus; devolve a grade por nome de aba. */
export async function fetchRanges(env: Env, sheetId: string, ranges: string[]): Promise<Record<string, Grid>> {
  const auth = await accessToken(env);
  const params = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" });
  for (const r of ranges) params.append("ranges", r);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${params}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { valueRanges: { range: string; values?: Grid }[] };
  const out: Record<string, Grid> = {};
  for (const vr of json.valueRanges) {
    const name = vr.range.split("!")[0].replace(/^'|'$/g, "").replace(/''/g, "'");
    out[name] = vr.values ?? [];
  }
  return out;
}

/** Lê as 4 abas da planilha de importação, com valores crus (datas como número serial). */
export async function fetchSheetTabs(env: Env): Promise<Record<string, Grid>> {
  return fetchRanges(env, env.IMPORT_SHEET_ID!, Object.values(TABS).map((t) => `'${t}'`));
}
