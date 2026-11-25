// Mês de lançamento escrito de vários jeitos (grupo do Monday, mês da Galeria) → AAAA-MM.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, janeiro: 1,
  feb: 2, fev: 2, february: 2, fevereiro: 2,
  mar: 3, march: 3, marco: 3,
  apr: 4, abr: 4, april: 4, abril: 4,
  may: 5, mai: 5, maio: 5,
  jun: 6, june: 6, junho: 6,
  jul: 7, july: 7, julho: 7,
  aug: 8, ago: 8, august: 8, agosto: 8,
  sep: 9, sept: 9, set: 9, september: 9, setembro: 9,
  oct: 10, out: 10, october: 10, outubro: 10,
  nov: 11, november: 11, novembro: 11,
  dec: 12, dez: 12, december: 12, dezembro: 12,
};

/** "March 2027", "Novembro 2026", "nov/2026", "11/2026" → "2027-03"; sem mês e ano reconhecíveis, null. */
export function launchMonth(group: string | null | undefined): string | null {
  if (!group) return null;
  const s = group.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const y2 = s.match(/[/\-\s']\s*(\d{2})\s*$/)?.[1];
  const year = s.match(/\b(20\d{2})\b/)?.[1] ?? (y2 ? `20${y2}` : null);
  if (!year) return null;
  for (const w of s.split(/[^a-z]+/)) {
    const m = MONTHS[w];
    if (m) return `${year}-${String(m).padStart(2, "0")}`;
  }
  const num = s.match(/\b(\d{1,2})\s*[/\-]\s*(20\d{2})\b/);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 12) return `${num[2]}-${num[1].padStart(2, "0")}`;
  return null;
}
