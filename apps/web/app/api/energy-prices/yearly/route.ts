import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type PseRow = { period: string; rce_pln: number; business_date: string };
type YearlyPrices = {
  source: string;
  unit: string;
  from: string;
  to: string;
  intervals: number;
  /** srednia RCE [miesiac 0-11][godzina lokalna 0-23], zl/kWh, ujemne ceny liczone jako 0 (zasada net-billingu) */
  matrix: number[][];
  /** to samo bez obcinania ujemnych cen -- do wykresow */
  raw_matrix: number[][];
  average: number;
  negative_hours_share: number;
  updated_at: string;
  disclaimer: string;
};

let cache: { expires: number; data: YearlyPrices } | null = null;
let inFlight: Promise<YearlyPrices> | null = null;

function warsawDate(date: Date) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function loadYear(): Promise<YearlyPrices> {
  const to = warsawDate(new Date(Date.now() - 86_400_000));
  const from = warsawDate(new Date(Date.now() - 365 * 86_400_000));
  const params = new URLSearchParams({
    $filter: `business_date ge '${from}' and business_date le '${to}'`,
    $select: "period,rce_pln,business_date",
    $first: "50000",
  });
  // ~35 tys. rekordow (okresy 15-min) -- za duze dla cache fetch Next.js, wiec trzymamy wynik w pamieci
  const response = await fetch(`https://api.raporty.pse.pl/api/rce-pln?${params}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`PSE API ${response.status}`);
  const rows = ((await response.json()) as { value: PseRow[] }).value ?? [];
  if (!rows.length) throw new Error("PSE nie zwróciło cen RCE");

  const sum = Array.from({ length: 12 }, () => new Array(24).fill(0));
  const sumClamped = Array.from({ length: 12 }, () => new Array(24).fill(0));
  const count = Array.from({ length: 12 }, () => new Array(24).fill(0));
  let negative = 0;
  for (const row of rows) {
    const month = Number(row.business_date.slice(5, 7)) - 1;
    const hour = Number(row.period.slice(0, 2)) % 24;
    const price = Number(row.rce_pln) / 1000; // zl/MWh -> zl/kWh
    if (!Number.isFinite(price) || month < 0 || month > 11) continue;
    sum[month][hour] += price;
    sumClamped[month][hour] += Math.max(0, price);
    count[month][hour]++;
    if (price < 0) negative++;
  }
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const matrix = sumClamped.map((row, m) => row.map((value, h) => round(count[m][h] ? value / count[m][h] : 0)));
  const rawMatrix = sum.map((row, m) => row.map((value, h) => round(count[m][h] ? value / count[m][h] : 0)));
  const total = rows.reduce((acc, row) => acc + Number(row.rce_pln) / 1000, 0);

  return {
    source: "PSE RCE (rynkowa cena energii)",
    unit: "PLN/kWh",
    from,
    to,
    intervals: rows.length,
    matrix,
    raw_matrix: rawMatrix,
    average: round(total / rows.length),
    negative_hours_share: Math.round((negative / rows.length) * 1000) / 1000,
    updated_at: new Date().toISOString(),
    disclaimer:
      "Wartość nadwyżek liczona po średnich cenach RCE z ostatnich 12 miesięcy dla danego miesiąca i godziny (ceny ujemne = 0 zł). Uproszczenie: pomija zasady wykorzystania depozytu prosumenckiego.",
  };
}

export async function GET() {
  try {
    if (!cache || cache.expires < Date.now()) {
      // jedno pobieranie naraz (kilka komponentow pyta rownolegle) + jedna ponowna proba
      inFlight ??= loadYear().catch(() => loadYear()).finally(() => { inFlight = null; });
      cache = { expires: Date.now() + 12 * 3_600_000, data: await inFlight };
    }
    return NextResponse.json(cache.data);
  } catch (error) {
    if (cache) return NextResponse.json(cache.data); // starsze dane lepsze niz brak
    return NextResponse.json({ detail: error instanceof Error ? error.message : "Nie udało się pobrać cen RCE" }, { status: 502 });
  }
}
