export type Cell = string | number | boolean | null;
export type Grid = Cell[][];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e];
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

/** Junta o texto de todos os <t> de um trecho (texto simples ou rich text). */
function textOf(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Leitor mínimo de .zip (o .xlsx é um zip): usa o diretório central e a
 * descompressão nativa do runtime, sem dependência externa.
 */
async function unzip(data: Uint8Array, keep: (name: string) => boolean): Promise<Record<string, string>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Arquivo não é um .xlsx válido");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Diretório do .xlsx corrompido");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!keep(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + compSize);
    if (method === 0) out[name] = decoder.decode(raw);
    else if (method === 8) out[name] = decoder.decode(await inflateRaw(raw));
    else throw new Error(`Compressão não suportada no .xlsx (${method})`);
  }
  return out;
}

/**
 * Lê um .xlsx e devolve as abas pedidas como grade de valores crus
 * (números continuam números, como a Sheets API com UNFORMATTED_VALUE).
 */
export async function readXlsx(data: Uint8Array, wanted?: string[]): Promise<Record<string, Grid>> {
  const files = await unzip(
    data,
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name === "xl/sharedStrings.xml" ||
      name.startsWith("xl/worksheets/sheet"),
  );
  const read = (name: string) => files[name] ?? "";

  const shared: string[] = [];
  for (const m of read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Ignora a transcrição fonética (<rPh>) que alguns arquivos trazem.
    shared.push(textOf(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "")));
  }

  const rels: Record<string, string> = {};
  for (const m of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const target = a.Target.startsWith("/") ? a.Target.slice(1) : `xl/${a.Target}`;
    rels[a.Id] = target;
  }

  const out: Record<string, Grid> = {};
  for (const m of read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const name = a.name;
    if (wanted && !wanted.includes(name)) continue;
    const path = rels[a["r:id"]];
    if (!path || !files[path]) continue;
    out[name] = parseSheet(files[path], shared);
  }
  return out;
}

function parseSheet(xml: string, shared: string[]): Grid {
  const grid: Grid = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    const r = ra.r ? parseInt(ra.r, 10) - 1 : nextRow;
    nextRow = r + 1;
    const body = rm[2];
    if (!body) continue;
    const row: Cell[] = [];
    let nextCol = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      const c = ca.r ? colIndex(ca.r) : nextCol;
      nextCol = c + 1;
      const inner = cm[2] ?? "";
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value: Cell = null;
      switch (ca.t) {
        case "s":
          value = v != null ? shared[parseInt(v, 10)] ?? null : null;
          break;
        case "inlineStr":
          value = textOf(inner);
          break;
        case "str":
        case "e":
          value = v != null ? decodeXml(v) : null;
          break;
        case "b":
          value = v === "1";
          break;
        default:
          value = v != null && v !== "" ? Number(v) : null;
      }
      row[c] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    grid[r] = row;
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}
