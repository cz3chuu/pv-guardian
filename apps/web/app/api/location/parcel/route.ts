import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query || query.length < 2) return NextResponse.json({ error: "Podaj identyfikator albo obręb i numer działki" }, { status: 400 });
  const url = new URL("https://uldk.gugik.gov.pl/");
  url.searchParams.set("request", "GetParcelByIdOrNr");
  url.searchParams.set("id", query);
  url.searchParams.set("result", "id,parcel,voivodeship,county,commune,region,geom_wkt");
  url.searchParams.set("srid", "4326");
  const response = await fetch(url, { headers: { "User-Agent": "PVGuardian/0.1" }, cache: "no-store" });
  if (!response.ok) return NextResponse.json({ error: "Usługa działek ULDK jest chwilowo niedostępna" }, { status: 502 });
  const lines = (await response.text()).trim().split(/\r?\n/);
  const declaredCount = Number(lines.shift());
  if (!Number.isFinite(declaredCount) || declaredCount === 0) return NextResponse.json([]);
  const parcels = lines.slice(0, 20).map((line) => {
    const [id, parcel, voivodeship, county, commune, region, wkt = ""] = line.split("|");
    const coordinates: [number, number][] = [];
    for (const match of wkt.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)) coordinates.push([Number(match[1]), Number(match[2])]);
    const longitude = coordinates.reduce((sum, point) => sum + point[0], 0) / coordinates.length;
    const latitude = coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length;
    return { id, parcel, voivodeship, county, commune, region, latitude, longitude, coordinates };
  }).filter((item) => Number.isFinite(item.latitude) && item.coordinates.length >= 3);
  return NextResponse.json(parcels);
}
