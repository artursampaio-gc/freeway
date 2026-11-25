import type { Env } from "../env";
import { accessToken } from "../sheet/google";

// Google Drive, só leitura, com a conta de serviço da planilha. Usado para a
// documentação do pedido (FileMaker v2), nunca para a Pasta Arquivos de importação.
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  webViewLink?: string;
  /** Drive compartilhado onde o item está (vazio no Meu Drive de alguém). */
  driveId?: string;
}

export function driveConfigured(env: Env): boolean {
  return !!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY);
}

export async function driveAuth(env: Env): Promise<string> {
  return accessToken(env, SCOPE);
}

async function get(auth: string, path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${auth}` } });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/**
 * Lista arquivos. Num Drive compartilhado a busca vai só nele (corpora=drive),
 * porque a busca em todos os Drives de uma vez pode voltar incompleta.
 */
async function list(auth: string, q: string, opts: { driveId?: string; corpora?: string; max?: number } = {}): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const params: Record<string, string> = {
      q, pageSize: "1000", includeItemsFromAllDrives: "true", supportsAllDrives: "true",
      fields: "nextPageToken, incompleteSearch, files(id, name, mimeType, parents, modifiedTime, webViewLink, driveId)",
    };
    if (opts.driveId) Object.assign(params, { corpora: "drive", driveId: opts.driveId });
    else params.corpora = opts.corpora ?? "allDrives";
    if (pageToken) params.pageToken = pageToken;
    const json = await get(auth, "files", params);
    out.push(...json.files);
    pageToken = json.nextPageToken ?? "";
  } while (pageToken && out.length < (opts.max ?? 1000));
  return out;
}

export const isFolder = (f: DriveFile) => f.mimeType === FOLDER;

/** Drives compartilhados de que a conta de serviço é membro. */
export async function sharedDrives(auth: string): Promise<{ id: string; name: string }[]> {
  return (await get(auth, "drives", { pageSize: "100" })).drives ?? [];
}

/** Pastas compartilhadas diretamente com a conta de serviço. */
export async function sharedWithMe(auth: string): Promise<DriveFile[]> {
  return list(auth, `sharedWithMe and mimeType = '${FOLDER}' and trashed = false`, { corpora: "user" });
}

/** Todas as pastas que a busca encontra (pode vir incompleta; serve só para achar raízes). */
export async function allFolders(auth: string): Promise<DriveFile[]> {
  return list(auth, `mimeType = '${FOLDER}' and trashed = false`, { max: 20000 });
}

/** Exporta uma planilha do Google como .xlsx (valores já calculados, todas as abas). */
export async function exportXlsx(auth: string, fileId: string, timeoutMs = 90_000): Promise<Uint8Array> {
  const res = await fetch(`${API}/files/${fileId}/export?mimeType=${encodeURIComponent("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`, {
    headers: { Authorization: `Bearer ${auth}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Drive export ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function children(auth: string, folderId: string, opts: { driveId?: string; foldersOnly?: boolean; max?: number } = {}): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed = false${opts.foldersOnly ? ` and mimeType = '${FOLDER}'` : ""}`;
  return list(auth, q, { driveId: opts.driveId, max: opts.max });
}
