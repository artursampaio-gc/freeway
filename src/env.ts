export interface DB {
  query(sql: string, params: unknown[]): Promise<{ columns: string[]; rows: Record<string, any>[]; rowsRead: number }>;
  exec(sql: string, params: unknown[]): Promise<{ rowsWritten: number }>;
}

export interface Env {
  DB: DB;
  GODEPLOY_CRON_KEY?: string;
  // Data proxy do GoDeploy (bases governadas; só com o cookie de quem está usando o app)
  PROXY_BASE_URL?: string;
  // Planilha via Sheets API (conta de serviço)
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
  IMPORT_SHEET_ID?: string;
  // Planilha DB-Produtos e Estoque (opcional: o padrão está em domain/products.ts)
  PRODUCTS_SHEET_ID?: string;
  // Planilha Notas de Importação do time fiscal (opcional: o padrão está em integrations/fiscal.ts)
  FISCAL_SHEET_ID?: string;
  // FedEx Track API
  FEDEX_CLIENT_ID?: string;
  FEDEX_CLIENT_SECRET?: string;
  // AI Proxy da empresa (GPT)
  AI_PROXY_TOKEN?: string;
  // API do Monday (token pessoal ou de um usuário de integração)
  MONDAY_TOKEN?: string;
  // Chave gdk_ para o app de industrialização de Itapeva (be8422ca)
  ITAPEVA_API_KEY?: string;
  // Token de API do GoProduct (InvenTree): catálogo, links e miniaturas dos produtos
  GOPRODUCT_TOKEN?: string;
  // Bot do app Freeway no Slack (xoxb-…): avisos por mensagem direta
  SLACK_BOT_TOKEN?: string;
  // Chave gdk_ para o MCP da Galeria de Lançamentos (9c5a5d2c)
  GALERIA_API_KEY?: string;
  // Lista extra de admins, separada por vírgula
  ADMIN_EMAILS?: string;
}
