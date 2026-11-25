// Simula a API GraphQL do Monday nos testes locais: 130 quadros (para passar
// de uma página) mais um quadro de subitens que deve ficar de fora.
const BOARDS = [
  { id: "900001", name: "Importação - Controle de Pedidos", type: "board", items_count: 412, updated_at: "2026-10-30T12:00:00Z", workspace: { name: "Supply" } },
  { id: "900002", name: "03 - Warehouse Samples", type: "board", items_count: 230, updated_at: "2026-10-29T18:00:00Z", workspace: { name: "Engenharia" } },
  { id: "900003", name: "Subitems of Importação", type: "sub_items_board", items_count: 50, updated_at: "2026-10-30T12:00:00Z", workspace: { name: "Supply" } },
  ...Array.from({ length: 128 }, (_, i) => ({ id: String(910000 + i), name: `Quadro ${i + 1}`, type: "board", items_count: i, updated_at: "2026-01-01T00:00:00Z", workspace: null })),
];

export const mondayCalls: string[] = [];
export const mondayWrites: { board: string; item: string; vals: Record<string, unknown> }[] = [];
/** Valores trocados "no Monday" durante o teste (por item). */
export const mondayOverrides = new Map<string, { id: string; text: string }[]>();

// Um item do Launches 2026 (quadro 777000) com o subelemento Importação (quadro de subelementos 888000).
const SPECIAL: Record<string, any> = {
  "7770001": {
    id: "7770001", name: "Slim Fold - BBI25205", url: null, board: { id: "777000" }, updated_at: "2026-10-30T10:00:00Z", group: { title: "x" },
    column_values: [{ id: "status", text: "Working on it" }],
    subitems: [{ id: "8880001", name: "Importação", url: null, board: { id: "888000" }, column_values: [{ id: "status", text: "Aguardando" }] }],
  },
  "8880001": { id: "8880001", name: "Importação", url: null, board: { id: "888000" }, updated_at: "2026-10-30T10:00:00Z", group: null, column_values: [{ id: "status", text: "Aguardando" }] },
};
const SUBBOARD = {
  id: "888000", name: "Subitems of Launches 2026",
  columns: [
    { id: "status", title: "Status", type: "status", settings_str: JSON.stringify({ labels: { "0": "Aguardando", "1": "Em Desenvolvimento", "2": "Feito" } }) },
    { id: "date0", title: "Previsão", type: "date", settings_str: "{}" },
  ],
  groups: [],
};

/** Itens de um quadro: um com o código no nome, um na coluna Process e um sem código. */
function boardItems(boardId: string) {
  return [
    { id: `${boardId}1`, name: "Slim Fold - BBI25205", updated_at: "2026-10-30T10:00:00Z", group: { title: "Em andamento" }, column_values: [{ id: "status", text: "Working on it" }] },
    { id: `${boardId}2`, name: "Garrafa térmica", updated_at: "2026-10-30T10:00:00Z", group: { title: "Em andamento" }, column_values: [{ id: "text_p", text: "GOC25007" }] },
    { id: `${boardId}3`, name: "Amostra sem código", updated_at: "2026-10-30T10:00:00Z", group: { title: "Em andamento" }, column_values: [] },
  ];
}

export function installFakeMonday() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.monday.com/")) return realFetch(input, init);
    const { query, variables } = JSON.parse(String(init?.body));
    mondayCalls.push(query);
    let data: unknown;
    if (String(query).includes("change_multiple_column_values")) {
      mondayWrites.push({ board: variables.board, item: variables.item, vals: JSON.parse(variables.vals) });
      data = { change_multiple_column_values: { id: variables.item } };
    } else if (String(query).includes("items_page")) {
      data = { boards: [{ items_page: { cursor: null, items: boardItems(variables.ids[0]) } }] };
    } else if (String(query).includes("items(ids")) {
      const withOverride = (it: any) => (mondayOverrides.has(it.id) ? { ...it, column_values: mondayOverrides.get(it.id) } : it);
      data = { items: (variables.ids as string[]).flatMap((id) => (SPECIAL[id] ? [withOverride(SPECIAL[id])] : boardItems(id.slice(0, -1)).filter((it) => it.id === id))) };
    } else if (variables?.ids?.includes(SUBBOARD.id)) {
      data = { boards: [SUBBOARD] };
    } else if (variables?.ids) {
      data = {
        boards: BOARDS.filter((b) => variables.ids.includes(b.id)).map((b) => ({
          id: b.id, name: b.name,
          columns: [{ id: "name", title: "Name", type: "name" }, { id: "status", title: "Status", type: "status" }, { id: "date4", title: "ETA", type: "date" }, { id: "text_p", title: "Process", type: "text" }],
          groups: [{ title: "Em andamento" }],
        })),
      };
    } else {
      const page = variables?.page ?? 1;
      data = { boards: BOARDS.slice((page - 1) * 100, page * 100) };
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
