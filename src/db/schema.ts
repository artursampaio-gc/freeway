import type { DB } from "../env";
import { one, run } from "./q";

// Cada item da lista é uma migração. Só se acrescenta no fim; nunca se edita uma já publicada.
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS orders (
      process_code TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      description TEXT, area TEXT, category TEXT, buyer TEXT, supplier TEXT,
      po_status TEXT, production_status TEXT, production_status_raw TEXT,
      po_date TEXT, prod_start_sheet TEXT, prod_end_sheet TEXT, leadtime TEXT,
      qty_total REAL, sku_count REAL, pending_delivery REAL,
      files_url TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'sheet',
      row_hash TEXT, removed_at TEXT, updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS shipments (
      pi_number TEXT PRIMARY KEY,
      process_code TEXT NOT NULL,
      seq INTEGER,
      status TEXT, status_raw TEXT, destination TEXT,
      modal TEXT, trader TEXT, carrier_line TEXT, ref_bl TEXT, qty REAL,
      etd TEXT, eta TEXT, duimp_at TEXT, draft_duimp TEXT, canal TEXT,
      sefaz_at TEXT, nf TEXT, nf_date TEXT, delivery_forecast TEXT, notes TEXT,
      delivered_at TEXT,
      row_hash TEXT, removed_at TEXT, updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_shipments_process ON shipments(process_code)`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      process_code TEXT NOT NULL,
      item_supplier TEXT, sku TEXT, sku_key TEXT, line TEXT,
      qty REAL, shipped_qty REAL, pending_qty REAL,
      row_hash TEXT, removed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_process ON order_items(process_code)`,
    `CREATE TABLE IF NOT EXISTS shipment_items (
      id TEXT PRIMARY KEY,
      pi_number TEXT NOT NULL,
      process_code TEXT NOT NULL,
      item_supplier TEXT, sku TEXT, qty REAL, boxes REAL,
      row_hash TEXT, removed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_shipment_items_pi ON shipment_items(pi_number)`,
    `CREATE TABLE IF NOT EXISTS step_state (
      scope TEXT NOT NULL,
      step_key TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT, updated_by TEXT,
      PRIMARY KEY (scope, step_key)
    )`,
    `CREATE TABLE IF NOT EXISTS item_checks (
      shipment_item_id TEXT PRIMARY KEY,
      done_at TEXT NOT NULL, done_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS watchers (
      process_code TEXT NOT NULL,
      user_email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (process_code, user_email)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_watchers_user ON watchers(user_email)`,
    `CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      first_seen_at TEXT, last_seen_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS team_members (
      team_key TEXT NOT NULL,
      user_email TEXT NOT NULL,
      PRIMARY KEY (team_key, user_email)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_code TEXT NOT NULL,
      pi_number TEXT, step_key TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      old_value TEXT, new_value TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_process ON events(process_code, created_at)`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nkey TEXT NOT NULL UNIQUE,
      process_code TEXT, pi_number TEXT, step_key TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notification_recipients (
      notification_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      reason TEXT,
      read_at TEXT,
      PRIMARY KEY (notification_id, user_email)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_nr_user ON notification_recipients(user_email, read_at)`,
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_code TEXT NOT NULL,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL, mime TEXT, size INTEGER,
      content_b64 TEXT NOT NULL,
      uploaded_by TEXT, uploaded_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sheet_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      ran_at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      summary TEXT, issues TEXT
    )`,
    `INSERT OR IGNORE INTO teams (key, name) VALUES
      ('importacao', 'Importação'), ('itapeva', 'Itapeva'), ('ecommerce', 'E-commerce'),
      ('filmagem', 'Filmagem'), ('ilustracao', 'Ilustração'), ('marketing', 'Marketing')`,
  ],
  [
    // Leitura das notas pela IA, uma linha por pedido.
    `CREATE TABLE IF NOT EXISTS ai_insights (
      process_code TEXT PRIMARY KEY,
      input_hash TEXT NOT NULL,
      result TEXT,
      error TEXT,
      model TEXT, tokens INTEGER,
      created_at TEXT NOT NULL
    )`,
  ],
  [
    // Código do SKU (Chave da planilha, completado pelo GoProduct) e documento por embarque.
    `ALTER TABLE shipment_items ADD COLUMN sku_key TEXT`,
    `ALTER TABLE shipment_items ADD COLUMN sku_code TEXT`,
    `ALTER TABLE order_items ADD COLUMN sku_code TEXT`,
    `ALTER TABLE documents ADD COLUMN unit TEXT`,
  ],
  [
    // Quadros do Monday escolhidos pelo usuário em 30/10/2026 (dá para mudar em Configuração).
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('monday_boards', '${JSON.stringify([
      { id: "18407608425", name: "06 - Shipping Schedule 2026*" },
      { id: "18408058138", name: "07 - Reorders 2026/2027*" },
      { id: "781893742", name: "01 - Samples China*" },
      { id: "6758443649", name: "02 - Warehouse Samples*" },
      { id: "8700824124", name: "04 - Inspection China*" },
      { id: "9392961557", name: "⭐️ Launches 2026*" },
      { id: "18412582876", name: "⭐️ Launches 2027*" },
    ])}')`,
  ],
  [
    // Espelho dos itens dos quadros do Monday e o pedido (ou pedidos) a que cada um se liga.
    `CREATE TABLE IF NOT EXISTS monday_items (
      item_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT, group_title TEXT, updated_at TEXT,
      vals TEXT,
      process_codes TEXT,
      matched_by TEXT,
      row_hash TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_monday_items_board ON monday_items(board_id)`,
  ],
  [
    // Pasta de cada pedido dentro da pasta do FileMaker no Drive (documentação do pedido).
    `CREATE TABLE IF NOT EXISTS order_docs (
      process_code TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      folder_name TEXT, link TEXT, path TEXT,
      checked_at TEXT
    )`,
  ],
  [
    // Amostras do Warehouse Samples ligadas aos pedidos (pela IA ou confirmadas no app).
    `ALTER TABLE monday_items ADD COLUMN url TEXT`,
    `CREATE TABLE IF NOT EXISTS sample_links (
      item_id TEXT PRIMARY KEY,
      process_codes TEXT NOT NULL DEFAULT '[]',
      confirmed TEXT NOT NULL DEFAULT '[]',
      rejected TEXT NOT NULL DEFAULT '[]',
      confidence REAL,
      status TEXT NOT NULL,
      evidence TEXT,
      used_image INTEGER,
      input_hash TEXT,
      decided_at TEXT
    )`,
  ],
  [
    // Drive compartilhado onde fica a pasta do pedido (as buscas nele vão só nele).
    `ALTER TABLE order_docs ADD COLUMN drive_id TEXT`,
  ],
  [
    // Ordens de produção do GDI (industrialização de Itapeva). Chave = id (UUID), nunca o número.
    `CREATE TABLE IF NOT EXISTS gdi_ordens (
      id TEXT PRIMARY KEY,
      numero TEXT, prefixo TEXT, tipo TEXT,
      item TEXT, pedido TEXT, status TEXT, concluido_em TEXT,
      data TEXT,
      row_hash TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gdi_ordens_item ON gdi_ordens(item)`,
  ],
  [
    // Quantidade e criação da OP, e quanto de cada item de frete já foi industrializado segundo o GDI.
    `ALTER TABLE gdi_ordens ADD COLUMN quantidade REAL`,
    `ALTER TABLE gdi_ordens ADD COLUMN criado_em TEXT`,
    `CREATE TABLE IF NOT EXISTS gdi_alloc (
      shipment_item_id TEXT PRIMARY KEY,
      done_qty REAL, doing_qty REAL,
      ops TEXT,
      last_done_at TEXT,
      auto_checked_at TEXT,
      row_hash TEXT
    )`,
  ],
  [
    // O que o Freeway escreveu no Monday (sincronização manual pela página do pedido).
    `CREATE TABLE IF NOT EXISTS monday_writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL, board_id TEXT, column_id TEXT, value TEXT,
      process_code TEXT, written_by TEXT, written_at TEXT
    )`,
  ],
  [
    // Cadastro no site, no WMS e lançamento marcados por item (SKU) do pedido ou do frete.
    `CREATE TABLE IF NOT EXISTS item_marks (
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      done_at TEXT NOT NULL, done_by TEXT,
      PRIMARY KEY (item_id, kind)
    )`,
  ],
  [
    // Planilha DB-Produtos e Estoque: de-para dos códigos por produto e saldo do WMS por código e armazém.
    `CREATE TABLE IF NOT EXISTS product_codes (
      base_code TEXT PRIMARY KEY,
      sku_unico TEXT, categoria TEXT, linha TEXT,
      wms TEXT, factory TEXT, webgex TEXT, supplier_code TEXT,
      status TEXT, origem TEXT, fornecedor TEXT, leadtime TEXT,
      row_hash TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS wms_stock (
      codigo TEXT NOT NULL, armazem TEXT NOT NULL,
      base_code TEXT,
      saldo_disponivel REAL, saldo_total REAL, atualizado_em TEXT,
      row_hash TEXT,
      PRIMARY KEY (codigo, armazem)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wms_stock_base ON wms_stock(base_code)`,
  ],
  [
    // Base da fábrica (lida pelo data proxy quando alguém usa o app): material de cada item
    // (pelo código WMS ou pelo nome), se está ativo e o saldo pronto em Extrema (centro 11).
    `CREATE TABLE IF NOT EXISTS factory_items (
      item_key TEXT PRIMARY KEY,
      material_id INTEGER, slug TEXT, name TEXT, via TEXT,
      created_at TEXT, active INTEGER,
      extrema_ready REAL, extrema_total REAL,
      live_since TEXT,
      checked_at TEXT NOT NULL
    )`,
  ],
  [
    // Catálogo do GoProduct (link e miniatura de cada produto pelo IPN = código WMS) e miniaturas baixadas.
    `CREATE TABLE IF NOT EXISTS goproduct_parts (
      pk INTEGER PRIMARY KEY, ipn TEXT, name TEXT, thumbnail TEXT, active INTEGER, updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_goproduct_parts_ipn ON goproduct_parts(ipn)`,
    `CREATE TABLE IF NOT EXISTS goproduct_images (
      pk INTEGER PRIMARY KEY, content_type TEXT, data TEXT, fetched_at TEXT
    )`,
  ],
  [
    // Por aparelho do item: material na fábrica, saldo em Extrema e presença no site (modelo × aparelho + estoque do site).
    `ALTER TABLE factory_items ADD COLUMN parts TEXT`,
    `ALTER TABLE factory_items ADD COLUMN n_targets INTEGER`,
    `ALTER TABLE factory_items ADD COLUMN reg_count INTEGER`,
    `ALTER TABLE factory_items ADD COLUMN site_count INTEGER`,
    `ALTER TABLE factory_items ADD COLUMN site_checked INTEGER`,
  ],
  [
    // Avisos também por mensagem direta no Slack: quando saiu (ou por que não saiu), quem desligou e o id de cada pessoa no Slack.
    `ALTER TABLE notification_recipients ADD COLUMN slack_at TEXT`,
    `ALTER TABLE notification_recipients ADD COLUMN slack_error TEXT`,
    `ALTER TABLE users ADD COLUMN slack_off INTEGER`,
    `CREATE TABLE IF NOT EXISTS slack_users (
      email TEXT PRIMARY KEY, slack_id TEXT, error TEXT, checked_at TEXT
    )`,
  ],
  [
    // Título dado no app ao pedido (unit = código do processo) ou a um frete de pedido dividido (unit = PI).
    // Fica fora de orders para a planilha nunca sobrescrever.
    `CREATE TABLE IF NOT EXISTS unit_titles (
      unit TEXT PRIMARY KEY, process_code TEXT NOT NULL, title TEXT NOT NULL, updated_by TEXT, updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_unit_titles_process ON unit_titles(process_code)`,
  ],
  [
    // Trilha de desenvolvimento: tarefas dos lançamentos (subelementos do Launches no Monday),
    // lista de SKUs (PO do FileMaker ou lista temporária), POs já lidas e quem passou a observar sozinho.
    `CREATE TABLE IF NOT EXISTS monday_subitems (
      subitem_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, board_id TEXT, pos INTEGER, name TEXT, vals TEXT, updated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_monday_subitems_parent ON monday_subitems(parent_id)`,
    `CREATE TABLE IF NOT EXISTS sku_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, code TEXT, name TEXT, qty REAL, source TEXT NOT NULL, created_by TEXT, created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sku_lists_scope ON sku_lists(scope)`,
    `CREATE TABLE IF NOT EXISTS po_files (
      process_code TEXT PRIMARY KEY, file_id TEXT, file_name TEXT, modified_at TEXT, rows INTEGER, error TEXT, parsed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS auto_watch (
      process_code TEXT NOT NULL, user_email TEXT NOT NULL, item_id TEXT, created_at TEXT, PRIMARY KEY (process_code, user_email)
    )`,
  ],
  [
    // Cor de cada produto no GoProduct (para a definição de cores) e o que as planilhas de Waitlist/CTR
    // dizem de cada lançamento (links, resultados, votos de cor, testes), casado de hora em hora.
    `ALTER TABLE goproduct_parts ADD COLUMN cor TEXT`,
    `ALTER TABLE goproduct_parts ADD COLUMN cor_hex TEXT`,
    `CREATE TABLE IF NOT EXISTS dev_sheet_match (item_id TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS goproduct_colors (pk INTEGER PRIMARY KEY, nome_pt TEXT, nome_en TEXT, hex TEXT, updated_at TEXT)`,
  ],
  [
    // Quem observa um lançamento (desenvolvimento) e a última situação vista de cada etapa, para avisar mudanças.
    `CREATE TABLE IF NOT EXISTS dev_watchers (item_id TEXT NOT NULL, user_email TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (item_id, user_email))`,
    `CREATE INDEX IF NOT EXISTS idx_dev_watchers_user ON dev_watchers(user_email)`,
    `CREATE TABLE IF NOT EXISTS dev_step_seen (item_id TEXT NOT NULL, step_key TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (item_id, step_key))`,
  ],
  [
    // Pedido cancelado ou on hold no app (vale para o pedido todo). Fica fora de orders para a planilha nunca sobrescrever.
    `CREATE TABLE IF NOT EXISTS order_hold (process_code TEXT PRIMARY KEY, state TEXT NOT NULL, note TEXT, updated_by TEXT, updated_at TEXT NOT NULL)`,
  ],
  [
    // Notas de Importação do time fiscal, lidas da planilha deles, com os embarques (PIs) ligados a cada processo.
    `CREATE TABLE IF NOT EXISTS fiscal_notes (processo TEXT PRIMARY KEY, data TEXT NOT NULL, pis TEXT NOT NULL, via TEXT, updated_at TEXT)`,
  ],
  [
    // Última situação vista de cada nota de importação, para avisar quando ela trava ou é emitida.
    `CREATE TABLE IF NOT EXISTS fiscal_seen (processo TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT)`,
  ],
  [
    // Cores do GoProduct com todos os pantones (cor composta = quadradinho fracionado) e a textura (miniatura no quadradinho).
    `ALTER TABLE goproduct_colors ADD COLUMN pantones TEXT`,
    `ALTER TABLE goproduct_colors ADD COLUMN textura TEXT`,
    `CREATE TABLE IF NOT EXISTS goproduct_textures (pk INTEGER PRIMARY KEY, url TEXT, content_type TEXT, data TEXT, fetched_at TEXT)`,
  ],
  [
    // Lançamentos da Galeria de Lançamentos (fotos e números), com o item do Monday a que cada um está ligado.
    `CREATE TABLE IF NOT EXISTS galeria_launches (slug TEXT PRIMARY KEY, item_id TEXT, via TEXT, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS galeria_launches_item ON galeria_launches (item_id)`,
  ],
  [
    // Atualização para o Monday marcada como incorreta: não é sugerida de novo enquanto o valor e o motivo forem os mesmos.
    `CREATE TABLE IF NOT EXISTS monday_dismissed (process_code TEXT NOT NULL, update_id TEXT NOT NULL, to_value TEXT NOT NULL, why TEXT NOT NULL, dismissed_by TEXT, dismissed_at TEXT NOT NULL, PRIMARY KEY (process_code, update_id))`,
    // Foto do produto enviada ao Slack (uma vez por imagem), para usar no cartão do aviso.
    `CREATE TABLE IF NOT EXISTS slack_images (key TEXT PRIMARY KEY, file_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
  ],
];

let migrated = false;

export async function migrate(db: DB): Promise<void> {
  if (migrated) return;
  await run(db, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = await one<{ version: number }>(db, `SELECT version FROM schema_version LIMIT 1`);
  let version = row?.version ?? 0;
  if (!row) await run(db, `INSERT INTO schema_version (version) VALUES (0)`);
  while (version < MIGRATIONS.length) {
    for (const stmt of MIGRATIONS[version]) await run(db, stmt);
    version++;
    await run(db, `UPDATE schema_version SET version = ?`, [version]);
  }
  migrated = true;
}
