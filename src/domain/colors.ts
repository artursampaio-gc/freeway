import type { DB } from "../env";
import { all } from "../db/q";
import type { ColorSwatch } from "../shared/types";

// Cores do cadastro do GoProduct (nome em português, em inglês e hexadecimal), para pintar o
// quadradinho das cores que vêm escritas na PO ("Sky Blue") ou digitadas no app ("Azul Céu").
// A lista abaixo é a do GoProduct em 11/11/2026 (sem as que estavam com cor provisória);
// as cores que aparecem nos produtos lidos de hora em hora (goproduct_colors) valem por cima dela.
// Do catálogo de cores vêm também os pantones (cor composta: quadradinho fracionado) e a textura.

const GP_COLORS: [string, string, string][] = [
  ["Açaí", "Acai", "#5d2b4f"], ["Amarelo", "Yellow", "#f3da20"], ["Amarelo Jelly", "Jelly Yellow", "#f8e599"],
  ["Amora", "Blackberry", "#6d1d36"], ["Azul Candy", "Candy Blue", "#b1d6d9"], ["Azul Céu", "Sky Blue", "#b6cfde"],
  ["Azul Céu e Off White", "Sky Blue and Off White", "#c1d3e1"], ["Azul Claro", "Light Blue", "#93a9cb"],
  ["Azul e Vermelho", "Dark Blue and Red", "#00205c"], ["Azul Jeans", "Denim Blue", "#3b4659"],
  ["Azul Jeans e Azul Claro", "Denim Blue and Light Blue", "#394456"], ["Azul Jeans e Off White", "Denim Blue and Off White", "#394456"],
  ["Azul Jelly", "Jelly Blue", "#a4dbe8"], ["Azul Marinho", "Dark Blue", "#00386c"], ["Bege", "Beige", "#c5b9ac"],
  ["Bege e Caramelo", "Beige and Caramel", "#c0b5a5"], ["Bordô", "Burgundy", "#472a42"], ["Branco", "White", "#ffffff"],
  ["Branco e Laranja", "White and Orange", "#ffffff"], ["Café", "Coffee", "#453536"], ["Capuccino", "Capuccino", "#cec6b9"],
  ["Céu Noturno", "Night Sky", "#1e252e"], ["Cinza", "Gray", "#a1a3a5"], ["Dourado", "Golden", "#d1ab6f"],
  ["Laranja", "Orange", "#f7986b"], ["Laranja Cósmico", "Cosmic Orange", "#ff8a3d"], ["Lemon", "Lemon", "#d9dc78"],
  ["Lilás", "Lilac", "#c5b5e3"], ["Lilás e Pink", "Lilac and Pink", "#bba2db"], ["Lilás e Rosa", "Lilac and Light Pink", "#bba2db"],
  ["Malva", "Mauve", "#8f6971"], ["Marrom", "Brown", "#84412c"], ["Marrom com Amêndoa", "Brown and Almond", "#84412c"],
  ["Matcha", "Matcha", "#d1d3ce"], ["Melancia", "Watermelon", "#d15b73"], ["Off White", "Off White", "#d7c4b6"],
  ["Off White e Caramelo", "Off White and Caramel", "#d7c4b6"], ["Pink", "Pink", "#e10198"], ["Pink Bold", "Bold Pink", "#ef4c80"],
  ["Pitaya", "Pitaya", "#d2d2d0"], ["Prata", "Silver", "#c9c9c9"], ["Preto", "Black", "#000000"],
  ["Preto e Caramelo", "Black and Caramel", "#000000"], ["Preto e Cinza", "Black and Gray", "#000000"],
  ["Preto e Off White", "Black and Off White", "#000000"], ["Preto e Pink", "Black and Pink", "#000000"],
  ["Rosa", "Light Pink", "#f6cac0"], ["Rosa Candy", "Candy Pink", "#e9b7c3"], ["Rosa Candy e Vermelho", "Candy Pink and Red", "#e9b7c3"],
  ["Rosa e Lilás", "Light Pink and Lilac", "#eca1d0"], ["Rosa e Off White", "Light Pink and Off White", "#eec4ba"],
  ["Rosa e Rosa Escuro", "Light Pink and Dark Pink", "#f6cac0"], ["Rosa e Roxo", "Light Pink and Purple", "#eec4ba"],
  ["Rosa e Verde", "Light Pink and Green", "#eec4ba"], ["Rosa Jelly", "Jelly Pink", "#eebae2"], ["Rosa Pétala", "Petal Pink", "#f5dadf"],
  ["Roxo", "Purple", "#5f1143"], ["Salmão Glitter", "Glitter Salmon", "#dab1a2"], ["Transparente", "Transparent", "#ffffff"],
  ["Turquesa", "Turquoise", "#b7e2c2"], ["Uva", "Grape", "#552c3e"], ["Uva e Lilás", "Grape and Lilac", "#552c3e"],
  ["Uva e Off White", "Grape and Off White", "#552c3e"], ["Verde", "Green", "#046736"], ["Verde Candy", "Candy Green", "#c9d8b6"],
  ["Verde Militar", "Military Green", "#3c4626"], ["Vermelho", "Red", "#cf0130"], ["Vinho", "Wine", "#561c24"],
];

/** Nome da cor para comparar: sem acento, minúsculo, "grey" = "gray", "offwhite" = "off white". */
export function colorKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bgrey\b/g, "gray")
    .replace(/\boff-?white\b/g, "off white")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Nome da cor (em português ou inglês, já em colorKey) → como pintar o quadradinho. */
export type Palette = Map<string, ColorSwatch>;

interface PaletteRow {
  pk?: number | null;
  nome_pt: string | null;
  nome_en: string | null;
  hex: string | null;
  pantones?: string | null;
  textura?: string | null;
}

export function buildPalette(rows: PaletteRow[] = []): Palette {
  const p: Palette = new Map();
  const add = (name: string | null, sw: ColorSwatch) => {
    if (name && (sw.hex || sw.hexes?.length || sw.tex)) p.set(colorKey(name), sw);
  };
  for (const [pt, en, hex] of GP_COLORS) add(pt, { hex }), add(en, { hex });
  for (const r of rows) {
    let hexes: string[] = [];
    try {
      hexes = r.pantones ? (JSON.parse(r.pantones) as string[]).filter((h) => typeof h === "string") : [];
    } catch {
      hexes = [];
    }
    const sw: ColorSwatch = { hex: r.hex?.toLowerCase() ?? hexes[0] ?? null, hexes, tex: r.textura && r.pk ? `/api/goproduct/cor/${r.pk}/textura` : null };
    add(r.nome_pt, sw), add(r.nome_en, sw);
  }
  return p;
}

/**
 * Como pintar uma cor escrita: o nome igual a uma cor do GoProduct ou, se não houver, a maior
 * cor do GoProduct que aparece inteira no texto ("SKY BLUE 544C" → Sky Blue).
 */
export function paletteSwatch(name: string, palette: Palette): ColorSwatch | null {
  const k = colorKey(name);
  if (!k) return null;
  const exact = palette.get(k);
  if (exact) return exact;
  let best: [string, ColorSwatch] | null = null;
  for (const [n, sw] of palette) {
    if ((!best || n.length > best[0].length) && ` ${k} `.includes(` ${n} `)) best = [n, sw];
  }
  return best?.[1] ?? null;
}

export function paletteHex(name: string, palette: Palette): string | null {
  return paletteSwatch(name, palette)?.hex ?? null;
}

export async function loadPalette(db: DB): Promise<Palette> {
  return buildPalette(await all<PaletteRow>(db, `SELECT pk, nome_pt, nome_en, hex, pantones, textura FROM goproduct_colors`));
}
