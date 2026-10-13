import { NextRequest, NextResponse } from "next/server";

type AddressResult = { id: string; label: string; latitude: number; longitude: number; type: string; source: string; geometry: { type: string; coordinates: unknown } | null };

const cache = new Map<string, { expires: number; data: unknown }>();
let lastNominatimRequestAt = 0;
const USER_AGENT = process.env.NOMINATIM_USER_AGENT ?? "PVGuardian/0.2 (projekt PV Guardian)";

/**
 * Wyszukiwanie adresu:
 * 1. GUGiK UUG (panstwowy rejestr punktow adresowych) -- dokladny punkt budynku,
 *    wymaga formatu "Miejscowosc, Ulica Numer" (probujemy obu kolejnosci),
 * 2. Nominatim (OSM) -- miejsca bez numeru i obrysy budynkow.
 */
async function searchGugik(query: string): Promise<AddressResult[]> {
  const parts = query.split(",").map((part) => part.trim()).filter(Boolean);
  const candidates = parts.length >= 2 ? [`${parts[0]}, ${parts.slice(1).join(" ")}`, `${parts.slice(1).join(" ")}, ${parts[0]}`] : [];
  for (const address of candidates) {
    const url = new URL("https://services.gugik.gov.pl/uug/");
    url.searchParams.set("request", "GetAddress");
    url.searchParams.set("address", address);
    url.searchParams.set("srid", "4326");
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) continue;
    const body = (await response.json().catch(() => null)) as { results?: Record<string, Record<string, string | null>> | null } | null;
    // GUGiK zwraca tez podobne ulice (np. Arianska dla Florianskiej) -- zostawiamy tylko dokladne dopasowania
    const exact = Object.values(body?.results ?? {}).filter((item) => item.street_accuracy === "1" && item.number && item.x && item.y);
    if (exact.length)
      return exact.map((item) => ({
        id: `gugik-${item.teryt}-${item.ulic}-${item.number}`,
        label: `${item.street ? `${item.street} ` : ""}${item.number}, ${item.code ?? ""} ${item.city}`.replace(/\s+/g, " ").trim(),
        latitude: Number(item.y),
        longitude: Number(item.x),
        type: "address",
        source: "GUGiK",
        geometry: null,
      }));
  }
  return [];
}

async function searchNominatim(query: string): Promise<AddressResult[]> {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimRequestAt = Date.now();
  const url = new URL(process.env.GEOCODER_URL ?? "https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "pl");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("polygon_threshold", "0.00001");
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "pl" } });
  if (!response.ok) throw new Error("Usługa wyszukiwania adresów jest chwilowo niedostępna");
  const raw = (await response.json()) as Array<{ place_id: number; display_name: string; lat: string; lon: string; type: string; category?: string; geojson?: { type: string; coordinates: unknown } }>;
  return raw.map((item) => ({
    id: String(item.place_id),
    label: item.display_name,
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    type: item.type,
    source: "OpenStreetMap",
    // obrys ma sens tylko dla budynku -- dla ulicy czy miasta to nie jest dach
    geometry: item.category === "building" || item.type === "house" || item.type === "yes" ? item.geojson ?? null : null,
  }));
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query || query.length < 3) return NextResponse.json({ error: "Wpisz co najmniej 3 znaki" }, { status: 400 });
  const key = query.toLocaleLowerCase("pl-PL");
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return NextResponse.json(cached.data);

  try {
    const official = /\d/.test(query) ? await searchGugik(query) : [];
    const data = official.length ? official : await searchNominatim(query);
    cache.set(key, { expires: Date.now() + 24 * 60 * 60 * 1000, data });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Nie udało się wyszukać adresu" }, { status: 502 });
  }
}
