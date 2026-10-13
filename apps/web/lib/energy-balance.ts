/**
 * Godzinowy bilans energii domu z PV: produkcja (PVGIS, typowy rok) vs profil
 * zuzycia, z magazynem energii i wycena nadwyzek po cenach RCE (net-billing).
 *
 * Wszystkie serie godzinowe sa indeksowane od `start_utc` profilu PVGIS
 * (kolejne godziny UTC). Profil zuzycia jest okreslony w czasie lokalnym
 * (Europe/Warsaw), dlatego kazda godzine mapujemy na lokalny miesiac i godzine.
 */

export type HourlyProfile = { year: number; start_utc: string; kwh: number[]; beam_share: number[] };

/** Ceny [miesiac 0-11][godzina lokalna 0-23] w zl/kWh. */
export type PriceMatrix = number[][];

export type ConsumptionProfileId = "rodzina" | "rodzina-dom" | "firma" | "rolne";

/** Ksztalt dobowy zuzycia (dowolna skala, normalizowany w obliczeniach). */
export const DAILY_SHAPES: Record<ConsumptionProfileId, number[]> = {
  // domownicy poza domem w dzien roboczy
  rodzina: [.45, .38, .34, .32, .33, .45, .7, .85, .65, .5, .45, .43, .45, .5, .58, .7, .95, 1.25, 1.4, 1.3, 1.1, .85, .65, .52],
  // ktos jest w domu w dzien (praca zdalna, emeryci)
  "rodzina-dom": [.42, .36, .33, .31, .32, .42, .65, .85, .85, .8, .78, .82, .9, .85, .8, .85, 1, 1.2, 1.3, 1.2, 1.05, .82, .62, .5],
  firma: [.05, .04, .04, .04, .05, .15, .5, .85, 1, 1, 1, .95, .9, .95, 1, .95, .8, .4, .15, .08, .06, .05, .05, .05],
  rolne: [.5, .45, .4, .38, .55, .9, 1.2, .8, .65, .6, .7, .8, .85, .75, .7, .85, 1.1, 1.25, 1, .8, .7, .65, .6, .55],
};

export const PROFILE_LABELS: Record<ConsumptionProfileId, string> = {
  rodzina: "Rodzina (poza domem w dzień)",
  "rodzina-dom": "Rodzina (ktoś w domu w dzień)",
  firma: "Firma / biuro",
  rolne: "Gospodarstwo rolne",
};

/** Sezonowosc zuzycia gospodarstwa domowego (zima wyzej: oswietlenie, grzalki, dluzszy pobyt w domu). */
export const MONTHLY_CONSUMPTION_FACTORS = [1.18, 1.08, 1.02, .94, .9, .86, .87, .88, .92, 1, 1.1, 1.25];

const WARSAW_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", hourCycle: "h23", month: "numeric", hour: "numeric" });
const calendarCache = new Map<string, { month: Uint8Array; hour: Uint8Array }>();

/** Lokalny (Europe/Warsaw) miesiac 0-11 i godzina 0-23 dla kazdej godziny profilu. */
export function localCalendar(startUtc: string, length: number) {
  const key = `${startUtc}:${length}`;
  const cached = calendarCache.get(key);
  if (cached) return cached;
  const start = Date.parse(startUtc);
  const month = new Uint8Array(length);
  const hour = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const parts = WARSAW_PARTS.formatToParts(new Date(start + i * 3_600_000));
    month[i] = Number(parts.find((p) => p.type === "month")!.value) - 1;
    hour[i] = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  }
  const result = { month, hour };
  calendarCache.set(key, result);
  return result;
}

/** Godzinowe zuzycie [kWh] sumujace sie dokladnie do `annualKwh`. */
export function consumptionSeries(annualKwh: number, dailyShape: number[], startUtc: string, length: number, monthly = MONTHLY_CONSUMPTION_FACTORS) {
  const { month, hour } = localCalendar(startUtc, length);
  const raw = new Float64Array(length);
  let total = 0;
  for (let i = 0; i < length; i++) {
    raw[i] = Math.max(0, dailyShape[hour[i]] ?? 0) * monthly[month[i]];
    total += raw[i];
  }
  const scale = total > 0 ? annualKwh / total : 0;
  for (let i = 0; i < length; i++) raw[i] *= scale;
  return raw;
}

export type SellPricing = { mode: "rce"; matrix: PriceMatrix } | { mode: "fixed"; price: number };

export type BalanceInput = {
  /** produkcja calej instalacji [kWh] dla kolejnych godzin od startUtc */
  pv: ArrayLike<number>;
  startUtc: string;
  annualConsumptionKwh: number;
  dailyShape: number[];
  batteryKwh: number;
  buyPrice: number;
  sell: SellPricing;
};

export type MonthlyBalance = { production: number; consumption: number; selfUsed: number; exported: number; imported: number };

export type BalanceResult = {
  production: number;
  consumption: number;
  /** energia z PV zuzyta w domu (bezposrednio + przez magazyn) */
  selfUsed: number;
  exported: number;
  imported: number;
  batteryThroughput: number;
  /** udzial produkcji zuzytej na miejscu */
  selfRate: number;
  /** udzial zuzycia pokryty z PV */
  autarky: number;
  exportValue: number;
  avgExportPrice: number;
  annualSaving: number;
  monthly: MonthlyBalance[];
};

const BATTERY_EFFICIENCY = 0.92; // sprawnosc cyklu ladowanie-rozladowanie
const BATTERY_C_RATE = 0.5; // maks. moc ladowania/rozladowania = 0.5 * pojemnosc

export function simulateBalance(input: BalanceInput): BalanceResult {
  const length = input.pv.length;
  const { month, hour } = localCalendar(input.startUtc, length);
  const load = consumptionSeries(input.annualConsumptionKwh, input.dailyShape, input.startUtc, length);
  const eta = Math.sqrt(BATTERY_EFFICIENCY);
  const capacity = Math.max(0, input.batteryKwh);
  const maxPower = capacity * BATTERY_C_RATE;
  const monthly: MonthlyBalance[] = Array.from({ length: 12 }, () => ({ production: 0, consumption: 0, selfUsed: 0, exported: 0, imported: 0 }));

  let soc = 0;
  let production = 0, selfUsed = 0, exported = 0, imported = 0, throughput = 0, exportValue = 0;
  for (let i = 0; i < length; i++) {
    const pv = Math.max(0, input.pv[i]);
    const demand = load[i];
    const direct = Math.min(pv, demand);
    let surplus = pv - direct;
    let deficit = demand - direct;

    let discharge = 0;
    if (capacity > 0) {
      const charge = Math.min(surplus, maxPower, (capacity - soc) / eta);
      soc += charge * eta;
      surplus -= charge;
      discharge = Math.min(deficit, maxPower, soc * eta);
      soc -= discharge / eta;
      deficit -= discharge;
      throughput += discharge;
    }

    const price = input.sell.mode === "fixed" ? input.sell.price : Math.max(0, input.sell.matrix[month[i]]?.[hour[i]] ?? 0);
    exportValue += surplus * price;
    production += pv;
    selfUsed += direct + discharge;
    exported += surplus;
    imported += deficit;

    const m = monthly[month[i]];
    m.production += pv;
    m.consumption += demand;
    m.selfUsed += direct + discharge;
    m.exported += surplus;
    m.imported += deficit;
  }

  const consumption = input.annualConsumptionKwh;
  return {
    production,
    consumption,
    selfUsed,
    exported,
    imported,
    batteryThroughput: throughput,
    selfRate: production > 0 ? selfUsed / production : 0,
    autarky: consumption > 0 ? selfUsed / consumption : 0,
    exportValue,
    avgExportPrice: exported > 0 ? exportValue / exported : 0,
    annualSaving: selfUsed * input.buyPrice + exportValue,
    monthly,
  };
}

export type FinanceResult = {
  cost: number;
  payback: number | null;
  years: Array<{ year: number; energy: number; saving: number; cumulative: number }>;
  totalSavings: number;
};

/** Przeplywy pieniezne w horyzoncie 25 lat z degradacja paneli. */
export function financeProjection(balance: BalanceResult, cost: number, degradationPctPerYear: number, years = 25): FinanceResult {
  let cumulative = -cost;
  let payback: number | null = null;
  const rows = Array.from({ length: years }, (_, i) => {
    const factor = (1 - degradationPctPerYear / 100) ** i;
    const energy = balance.production * factor;
    const saving = balance.annualSaving * factor;
    const previous = cumulative;
    cumulative += saving;
    // zwrot z dokladnoscia do miesiaca
    if (payback === null && cumulative >= 0) payback = Math.round((i + (saving > 0 ? -previous / saving : 1)) * 10) / 10;
    return { year: i + 1, energy, saving, cumulative };
  });
  return { cost, payback, years: rows, totalSavings: cumulative };
}

/** Sredni profil dobowy [24] produkcji i zuzycia dla wybranego miesiaca. */
export function averageDay(series: ArrayLike<number>, startUtc: string, monthIndex: number) {
  const { month, hour } = localCalendar(startUtc, series.length);
  const sum = new Array(24).fill(0);
  const count = new Array(24).fill(0);
  for (let i = 0; i < series.length; i++) {
    if (month[i] !== monthIndex) continue;
    sum[hour[i]] += series[i];
    count[hour[i]]++;
  }
  return sum.map((value, h) => (count[h] ? value / count[h] : 0));
}
