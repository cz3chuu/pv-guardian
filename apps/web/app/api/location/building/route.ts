import { NextRequest, NextResponse } from "next/server";

const USER_AGENT = process.env.NOMINATIM_USER_AGENT ?? "PVGuardian/0.2 (projekt PV Guardian)";
const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

type Way = { id: number; tags?: Record<string, string>; geometry: Array<{ lat: number; lon: number }> };

function inside(longitude: number, latitude: number, ring: number[][]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > latitude) !== (yj > latitude) && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/**
 * Obrys budynku (OpenStreetMap, przez Overpass) dla punktu adresowego -- do
 * rysowania dachu. Punkt adresowy w OSM to czesto osobny wezel, wiec szukamy
 * budynku, ktory go zawiera, a w drugiej kolejnosci najblizszego.
 */
export async function GET(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("lat"));
  const longitude = Number(request.nextUrl.searchParams.get("lon"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return NextResponse.json({ error: "Podaj lat i lon" }, { status: 400 });

  const query = `[out:json][timeout:10];way["building"](around:25,${latitude},${longitude});out geom;`;
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
    next: { revalidate: 86_400 },
  }).catch(() => null);
  if (!response?.ok) return NextResponse.json({ geometry: null });

  const ways = ((await response.json()) as { elements?: Way[] }).elements ?? [];
  const rings = ways.filter((way) => way.geometry?.length >= 4).map((way) => way.geometry.map((point) => [point.lon, point.lat]));
  const containing = rings.find((ring) => inside(longitude, latitude, ring));
  const nearest = containing ?? rings
    .map((ring) => ({ ring, distance: Math.min(...ring.map(([lon, lat]) => (lon - longitude) ** 2 * Math.cos((latitude * Math.PI) / 180) ** 2 + (lat - latitude) ** 2)) }))
    .sort((a, b) => a.distance - b.distance)[0]?.ring;
  return NextResponse.json({ geometry: nearest ? { type: "Polygon", coordinates: [nearest] } : null, exact: Boolean(containing) });
}
