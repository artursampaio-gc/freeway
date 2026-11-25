// Confere se a conta de serviço lê a planilha pela Sheets API, com o mesmo
// código do servidor. Uso: node dist/sheets-check.mjs <chave.json> <id da planilha>
import { readFileSync } from "node:fs";
import type { Env } from "../src/env";
import { fetchSheetTabs } from "../src/sheet/google";
import { normalize } from "../src/sheet/normalize";

const [keyPath, sheetId] = process.argv.slice(2);
const key = JSON.parse(readFileSync(keyPath, "utf8"));
const env = {
  GOOGLE_SA_EMAIL: key.client_email,
  GOOGLE_SA_PRIVATE_KEY: key.private_key,
  IMPORT_SHEET_ID: sheetId,
} as Env;

const t0 = Date.now();
const tabs = await fetchSheetTabs(env);
console.log(`Sheets API respondeu em ${Date.now() - t0} ms`);
for (const [name, grid] of Object.entries(tabs)) console.log(`  ${name}: ${grid.length} linhas`);
const n = normalize(tabs);
console.log(`Normalizado: ${n.orders.length} processos, ${n.shipments.length} embarques, ${n.orderItems.length} itens, ${n.shipmentItems.length} itens de embarque, ${n.issues.length} avisos`);
console.log("Exemplo:", JSON.stringify(n.shipments.find((s) => s.pi_number === "BBI25205-2")));
