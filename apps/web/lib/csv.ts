export interface ParsedProductionRow {
  timestamp: Date;
  energyKwh: number;
}

export interface ParseResult {
  rows: ParsedProductionRow[];
  errors: string[];
  /** liczba wierszy zrodlowych zsumowanych do pelnych godzin (dane 5/15-minutowe) */
  aggregatedFrom: number;
}

export const DEFAULT_CSV_TIMEZONE = "Europe/Warsaw";

/**
 * Parsuje CSV z kolumnami `timestamp` i `energy_kwh`.
 *
 * - separator: przecinek, srednik albo tabulator (wykrywany z naglowka),
 *   liczby z kropka lub przecinkiem dziesietnym (eksporty z polskiego Excela),
 * - timestamp: ISO (`2025-06-01T10:00`, `2025-06-01 10:00`) albo `01.06.2025 10:00`;
 *   bez strefy w tekscie jest traktowany jako czas lokalny `timeZone`
 *   (domyslnie Europe/Warsaw, z obsluga zmiany czasu), a do bazy trafia UTC,
 * - znacznik oznacza POCZATEK okresu; dane 5/15/30-minutowe sa sumowane do
 *   pelnych godzin (10:00 = energia z 10:00-11:00).
 */
export function parseProductionCsv(text: string, timeZone: string = DEFAULT_CSV_TIMEZONE): ParseResult {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const errors: string[] = [];

  if (lines.length === 0 || lines[0] === "") {
    return { rows: [], errors: ["Pusty plik"], aggregatedFrom: 0 };
  }

  const delimiter = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const tsIdx = header.indexOf("timestamp");
  const kwhIdx = header.indexOf("energy_kwh");

  if (tsIdx === -1 || kwhIdx === -1) {
    return {
      rows: [],
      errors: [`Nieprawidłowy nagłówek. Oczekiwano kolumn "timestamp" i "energy_kwh", otrzymano: "${lines[0]}"`],
      aggregatedFrom: 0,
    };
  }

  const hourly = new Map<number, number>();
  const seenWallTimes = new Set<string>();
  let sourceRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = splitLine(line, delimiter);
    const tsRaw = cols[tsIdx];
    const kwhRaw = cols[kwhIdx];

    const timestamp = tsRaw ? parseTimestamp(tsRaw, timeZone, seenWallTimes) : null;
    const energyKwh = kwhRaw ? Number(kwhRaw.replace(/\s/g, "").replace(",", ".")) : NaN;

    if (!timestamp) {
      errors.push(`Wiersz ${i + 1}: nieprawidłowy lub nieistniejący (zmiana czasu) timestamp "${tsRaw}"`);
      continue;
    }
    if (!Number.isFinite(energyKwh) || energyKwh < 0) {
      errors.push(`Wiersz ${i + 1}: nieprawidłowa wartość energy_kwh "${kwhRaw}"`);
      continue;
    }

    const hour = Math.floor(timestamp.getTime() / 3_600_000) * 3_600_000;
    hourly.set(hour, (hourly.get(hour) ?? 0) + energyKwh);
    sourceRows++;
  }

  const rows = [...hourly.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, energyKwh]) => ({ timestamp: new Date(hour), energyKwh: Math.round(energyKwh * 10_000) / 10_000 }));

  return { rows, errors, aggregatedFrom: sourceRows > rows.length ? sourceRows : 0 };
}

function detectDelimiter(headerLine: string): string {
  if (headerLine.includes(";")) return ";";
  if (headerLine.includes("\t")) return "\t";
  return ",";
}

function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, "$1").trim());
}

const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const PL_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

function parseTimestamp(raw: string, timeZone: string, seenWallTimes: Set<string>): Date | null {
  if (HAS_ZONE.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  let parts: number[] | null = null;
  const iso = raw.match(ISO_LIKE);
  if (iso) parts = [+iso[1], +iso[2], +iso[3], +iso[4], +iso[5], +(iso[6] ?? 0)];
  const pl = raw.match(PL_DATE);
  if (pl) parts = [+pl[3], +pl[2], +pl[1], +pl[4], +pl[5], +(pl[6] ?? 0)];
  if (!parts) return null;

  const candidates = wallTimeToUtc(parts, timeZone);
  if (candidates.length === 0) return null;
  // Przy cofnieciu zegara (pazdziernik) godzina 02:xx wystepuje dwa razy --
  // pierwsze wystapienie to czas letni, drugie zimowy.
  const key = parts.join("-");
  const date = seenWallTimes.has(key) && candidates.length > 1 ? candidates[1] : candidates[0];
  seenWallTimes.add(key);
  return date;
}

/** Wszystkie chwile UTC, ktore w strefie `timeZone` maja podany czas zegarowy (0, 1 albo 2 przy zmianie czasu). */
export function wallTimeToUtc([year, month, day, hour, minute, second]: number[], timeZone: string): Date[] {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsets = new Set([offsetMs(asUtc - 3 * 3_600_000, timeZone), offsetMs(asUtc + 3 * 3_600_000, timeZone)]);
  return [...offsets]
    .map((offset) => asUtc - offset)
    .filter((candidate) => wallTimeMs(candidate, timeZone) === asUtc)
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms));
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallTimeMs(utcMs: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

function offsetMs(utcMs: number, timeZone: string): number {
  return wallTimeMs(utcMs, timeZone) - Math.floor(utcMs / 1000) * 1000;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
