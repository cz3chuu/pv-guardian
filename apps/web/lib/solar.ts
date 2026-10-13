/**
 * Geometria slonca i straty od zacienienia przez przeszkody (komin, drzewo,
 * sasiedni budynek) liczone godzina po godzinie na profilu PVGIS.
 */

const RAD = Math.PI / 180;

/**
 * Wysokosc i azymut slonca w srodku godziny zaczynajacej sie od `utcMs`
 * (algorytm NOAA, dokladnosc ~0.5 st.). Azymut: 0 = poludnie, + = zachod.
 */
export function sunPosition(utcMs: number, latitude: number, longitude: number) {
  const t = new Date(utcMs + 30 * 60_000);
  const startOfYear = Date.UTC(t.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((t.getTime() - startOfYear) / 86_400_000) + 1;
  const hour = t.getUTCHours() + t.getUTCMinutes() / 60;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const hourAngle = ((hour * 60 + eqtime + 4 * longitude) / 4 - 180) * RAD;
  const lat = latitude * RAD;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const elevation = 90 - Math.acos(cosZenith) / RAD;
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / RAD;
  return { elevation, azimuth };
}

export type ShadingObstacle = { longitude: number; latitude: number; height: number; widthM: number; depthM: number };
export type ShadingPanel = { surfaceId: string; center: [number, number] };

type Target = { azimuth: number; halfWidth: number; topElevation: number };

/**
 * Dla kazdej polaci zwraca godzinowy udzial paneli zasloniety od slonca
 * (0..1). Przeszkoda zaslania panel, gdy slonce jest w jej kierunku (w
 * granicach jej szerokosci katowej) i nizej niz jej wierzcholek.
 * `height` przeszkody to wysokosc ponad poziom paneli.
 */
export function shadedFractionBySurface(
  panels: ShadingPanel[],
  obstacles: ShadingObstacle[],
  startUtc: string,
  hours: number,
  activeHours: ArrayLike<number>,
  calibrationFactor = 1,
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  if (!panels.length || !obstacles.length) return result;

  const factor = Math.max(0.1, calibrationFactor || 1);
  const targetsByPanel = panels.map((panel) => {
    const [lon, lat] = panel.center;
    const mx = 111_320 * Math.cos(lat * RAD) * factor;
    const my = 110_540 * factor;
    const targets: Target[] = [];
    for (const obstacle of obstacles) {
      const east = (obstacle.longitude - lon) * mx;
      const north = (obstacle.latitude - lat) * my;
      const distance = Math.hypot(east, north);
      if (distance < 0.3 || obstacle.height <= 0) continue;
      // kierunek do przeszkody w konwencji azymutu slonca (0 = poludnie, + = zachod)
      const azimuth = Math.atan2(-east, -north) / RAD;
      const size = Math.max(obstacle.widthM, obstacle.depthM);
      targets.push({ azimuth, halfWidth: Math.atan2(size / 2, distance) / RAD, topElevation: Math.atan2(obstacle.height, distance) / RAD });
    }
    return { surfaceId: panel.surfaceId, targets };
  });

  const counts = new Map<string, number>();
  for (const panel of panels) counts.set(panel.surfaceId, (counts.get(panel.surfaceId) ?? 0) + 1);
  for (const id of counts.keys()) result.set(id, new Float32Array(hours));

  const start = Date.parse(startUtc);
  const { latitude, longitude } = { latitude: panels[0].center[1], longitude: panels[0].center[0] };
  for (let i = 0; i < hours; i++) {
    if (!(activeHours[i] > 0)) continue;
    const sun = sunPosition(start + i * 3_600_000, latitude, longitude);
    if (sun.elevation <= 0) continue;
    for (const panel of targetsByPanel) {
      const blocked = panel.targets.some((target) => {
        let delta = Math.abs(sun.azimuth - target.azimuth);
        if (delta > 180) delta = 360 - delta;
        return delta <= target.halfWidth && sun.elevation < target.topElevation;
      });
      if (blocked) result.get(panel.surfaceId)![i] += 1 / counts.get(panel.surfaceId)!;
    }
  }
  return result;
}

/** Produkcja po uwzglednieniu cienia: zaslonieta czesc traci promieniowanie bezposrednie. */
export function applyShading(kwh: ArrayLike<number>, beamShare: ArrayLike<number>, shadedFraction: Float32Array | undefined) {
  const out = new Float64Array(kwh.length);
  for (let i = 0; i < kwh.length; i++) out[i] = kwh[i] * (1 - (shadedFraction ? shadedFraction[i] * (beamShare[i] ?? 0) : 0));
  return out;
}
