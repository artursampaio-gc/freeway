import type { Env } from "../env";

const ENDPOINT = "https://api.monday.com/v2";
const PAGE = 100;

export function mondayConfigured(env: Env): boolean {
  return !!env.MONDAY_TOKEN;
}

/** Chama a API GraphQL do Monday com o token do secret MONDAY_TOKEN. */
export async function mondayQuery<T = any>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: env.MONDAY_TOKEN!, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Monday ${res.status}: ${text.slice(0, 300)}`);
  }
  const err = json.errors?.[0]?.message ?? json.error_message;
  if (!res.ok || err) throw new Error(`Monday ${res.status}: ${err ?? text.slice(0, 300)}`);
  return json.data as T;
}

export interface MondayBoard {
  id: string;
  name: string;
  workspace: string | null;
  items: number | null;
  updated_at: string | null;
}

export interface MondayColumn {
  id: string;
  title: string;
  type: string;
  /** Só nas colunas de status: os rótulos que existem no quadro. */
  labels?: string[];
}

/** Todos os quadros ativos que o token enxerga (sem quadros de subitens e documentos). */
export async function listBoards(env: Env): Promise<MondayBoard[]> {
  const out: MondayBoard[] = [];
  for (let page = 1; page <= 40; page++) {
    const data = await mondayQuery<{ boards: any[] }>(
      env,
      `query ($page: Int!) { boards(limit: ${PAGE}, page: $page, state: active) { id name type items_count updated_at workspace { name } } }`,
      { page },
    );
    for (const b of data.boards) {
      if (b.type && b.type !== "board") continue;
      out.push({ id: String(b.id), name: b.name, workspace: b.workspace?.name ?? null, items: b.items_count ?? null, updated_at: b.updated_at ?? null });
    }
    if (data.boards.length < PAGE) break;
  }
  return out.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

export interface MondayItem {
  id: string;
  name: string;
  group: string | null;
  updated_at: string | null;
  url: string | null;
  /** Texto de cada coluna preenchida, pelo título da coluna. */
  values: Record<string, string>;
}

const CODE = /\b(GOC|BBI)\s?-?\s?(\d{5})/gi;

/** Códigos de pedido citados no item: no nome, numa coluna ou no grupo. */
export function findCodes(it: MondayItem, known: Set<string>): { codes: string[]; by: string | null } {
  const places: [string, string][] = [["nome", it.name], ...Object.entries(it.values).map(([k, v]) => [`coluna ${k}`, v] as [string, string]), ["grupo", it.group ?? ""]];
  const codes: string[] = [];
  let by: string | null = null;
  for (const [where, text] of places) {
    for (const m of text.matchAll(CODE)) {
      const code = `${m[1].toUpperCase()}${m[2]}`;
      if (!known.has(code) || codes.includes(code)) continue;
      codes.push(code);
      by ??= where;
    }
  }
  return { codes, by };
}

/** Rastreio da amostra: costuma vir no nome ("FEDEX879110755050 GO CLIP MKT"), às vezes na coluna. */
export function sampleTracking(name: string, values: Record<string, string>): string {
  return values["Fedex number"] ?? name.match(/\b(?:FEDEX|DHL)\s?\d{9,15}/i)?.[0].replace(/\s/g, "") ?? "";
}

const ITEM_FIELDS =`id name url updated_at group { title } column_values { id text }`;

function toItem(it: any, titles: Map<string, string>): MondayItem {
  const values: Record<string, string> = {};
  for (const cv of it.column_values) {
    const title = titles.get(cv.id) ?? cv.id;
    if (cv.text && !(title in values)) values[title] = cv.text;
  }
  return { id: String(it.id), name: it.name, group: it.group?.title ?? null, updated_at: it.updated_at ?? null, url: it.url ?? null, values };
}

/** Todos os itens de um quadro (páginas de 500), com o texto das colunas preenchidas. */
export async function boardItems(env: Env, boardId: string, titles: Map<string, string>): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  const add = (items: any[]) => {
    for (const it of items) out.push(toItem(it, titles));
  };
  const first = await mondayQuery<{ boards: any[] }>(env, `query ($ids: [ID!]) { boards(ids: $ids) { items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } } } }`, { ids: [boardId] });
  let page = first.boards[0]?.items_page;
  add(page?.items ?? []);
  for (let i = 0; page?.cursor && i < 20; i++) {
    const next = await mondayQuery<{ next_items_page: any }>(env, `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`, { cursor: page.cursor });
    page = next.next_items_page;
    add(page.items);
  }
  return out;
}

/** Só id e data da última alteração de cada item do quadro: leve, para saber o que mudou. */
export async function boardItemStamps(env: Env, boardId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = (items: any[]) => {
    for (const it of items) out.set(String(it.id), it.updated_at ?? "");
  };
  const first = await mondayQuery<{ boards: any[] }>(env, `query ($ids: [ID!]) { boards(ids: $ids) { items_page(limit: 500) { cursor items { id updated_at } } } }`, { ids: [boardId] });
  let page = first.boards[0]?.items_page;
  add(page?.items ?? []);
  for (let i = 0; page?.cursor && i < 20; i++) {
    const next = await mondayQuery<{ next_items_page: any }>(env, `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { id updated_at } } }`, { cursor: page.cursor });
    page = next.next_items_page;
    add(page.items);
  }
  return out;
}

/** Itens escolhidos pelo id, com o texto das colunas (de 100 em 100). */
export async function itemsByIds(env: Env, ids: string[], titles: Map<string, string>): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await mondayQuery<{ items: any[] }>(env, `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { ${ITEM_FIELDS} } }`, { ids: ids.slice(i, i + 100) });
    out.push(...data.items.map((it) => toItem(it, titles)));
  }
  return out;
}

export interface RawItem {
  id: string;
  name: string;
  url: string | null;
  board_id: string | null;
  values: { id: string; text: string | null }[];
  subitems: RawItem[];
}

/** Itens com os subelementos (ao vivo), com os valores por id de coluna; os títulos dependem do quadro de cada um. */
export async function itemsWithSubitems(env: Env, ids: string[]): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const raw = (it: any): RawItem => ({
    id: String(it.id), name: it.name, url: it.url ?? null, board_id: it.board?.id ? String(it.board.id) : null,
    values: it.column_values ?? [], subitems: (it.subitems ?? []).map(raw),
  });
  for (let i = 0; i < ids.length; i += 50) {
    const data = await mondayQuery<{ items: any[] }>(
      env,
      `query ($ids: [ID!]) { items(ids: $ids, limit: 50) { id name url board { id } column_values { id text } subitems { id name url board { id } column_values { id text } } } }`,
      { ids: ids.slice(i, i + 50) },
    );
    out.push(...data.items.map(raw));
  }
  return out;
}

/** Arquivos anexados aos itens, com link público temporário (vale cerca de 1 hora). */
export async function itemAssets(env: Env, ids: string[]): Promise<Map<string, { name: string; url: string; ext: string }[]>> {
  const data = await mondayQuery<{ items: any[] }>(env, `query ($ids: [ID!]) { items(ids: $ids) { id assets { name public_url file_extension } } }`, { ids });
  return new Map(data.items.map((it) => [String(it.id), it.assets.map((a: any) => ({ name: a.name, url: a.public_url, ext: String(a.file_extension ?? "").toLowerCase().replace(".", "") }))]));
}

/** Rótulos de uma coluna de status, a partir do settings_str do Monday. */
function statusLabels(settings: string | null | undefined): string[] {
  try {
    return Object.values(JSON.parse(settings ?? "{}").labels ?? {}).map(String).filter(Boolean);
  } catch {
    return [];
  }
}

/** Colunas (com os rótulos das de status) e grupos dos quadros escolhidos. */
export async function boardColumns(env: Env, ids: string[]): Promise<{ id: string; name: string; columns: MondayColumn[]; groups: string[] }[]> {
  if (!ids.length) return [];
  const data = await mondayQuery<{ boards: any[] }>(env, `query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type settings_str } groups { title } } }`, { ids });
  return data.boards.map((b) => ({
    id: String(b.id),
    name: b.name,
    columns: b.columns.map((c: any) => ({ id: c.id, title: c.title, type: c.type, ...(c.type === "status" ? { labels: statusLabels(c.settings_str) } : {}) })),
    groups: b.groups.map((g: any) => g.title),
  }));
}

/** Escreve valores em colunas de um item. Status vai por rótulo (sem criar rótulo novo), data por AAAA-MM-DD. */
export async function writeColumns(env: Env, boardId: string, itemId: string, values: Record<string, unknown>): Promise<void> {
  await mondayQuery(
    env,
    `mutation ($board: ID!, $item: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals, create_labels_if_missing: false) { id } }`,
    { board: boardId, item: itemId, vals: JSON.stringify(values) },
  );
}
