"""
Generator syntetycznych danych produkcji PV -- do testowania pipeline'u
(upload CSV -> porownanie z prognoza -> anomaly detection) zanim bedzie
dostep do realnej instalacji z falownikiem online.

Domyslnie liczy oczekiwana produkcje z prostego modelu polozenia slonca
(elewacja sloneczna + clearness index dobowy z losowej zachmurzenia) --
dziala offline, bez zadnego zewnetrznego API.

Docelowo (kiedy skrypt odpalasz na infrastrukturze z dostepem do sieci)
mozna podmienic baseline na realne dane z PVGIS uzywajac juz gotowej
funkcji `fetch_pvgis_series` z app/services/pvgis.py -- patrz flaga
--use-pvgis. To da dokladniejszy baseline (uwzglednia realna klimatologie
danej lokalizacji), ale wymaga polaczenia z re.jrc.ec.europa.eu.

Output: CSV z kolumnami `timestamp,energy_kwh` -- dokladnie w formacie,
ktory bedzie przyjmowal upload w Next.js (Faza 2, tabela production_readings).

Uzycie:
    python scripts/generate_synthetic_production.py \
        --lat 50.87 --lon 20.63 --peak-power 6.5 \
        --start-date 2025-06-01 --days 60 \
        --output synthetic_production.csv
"""

from __future__ import annotations

import argparse
import csv
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass
class AnomalyWindow:
    start: datetime
    end: datetime
    multiplier: float
    label: str


def solar_elevation_deg(dt: datetime, latitude: float) -> float:
    """
    Uproszczona elewacja sloneczna (stopnie), bez korekty na dlugosc
    geograficzna i rownanie czasu -- wystarczajaco dobra do generowania
    realistycznego ksztaltu krzywej dobowej, nie do precyzyjnych obliczen.
    """
    day_of_year = dt.timetuple().tm_yday
    declination = 23.45 * math.sin(math.radians(360 / 365 * (284 + day_of_year)))

    hour_angle = 15 * (dt.hour + dt.minute / 60 - 12)

    lat_rad = math.radians(latitude)
    dec_rad = math.radians(declination)
    hour_rad = math.radians(hour_angle)

    sin_elev = math.sin(lat_rad) * math.sin(dec_rad) + math.cos(lat_rad) * math.cos(dec_rad) * math.cos(hour_rad)
    sin_elev = max(-1.0, min(1.0, sin_elev))
    return math.degrees(math.asin(sin_elev))


def clear_sky_power_kw(dt: datetime, latitude: float, peak_power_kwp: float, system_efficiency: float = 0.85) -> float:
    elevation = solar_elevation_deg(dt, latitude)
    if elevation <= 0:
        return 0.0
    irradiance_proxy = math.sin(math.radians(elevation)) ** 1.2
    return peak_power_kwp * irradiance_proxy * system_efficiency


def daily_clearness_indices(days: int, rng: random.Random) -> list[float]:
    """
    Jeden wspolczynnik 'pogody' na dzien (0=calkowicie zachmurzone,
    1=bezchmurne). Wiekszosc dni pogodnych/czesciowo pochmurnych, co jakis
    czas gorszy dzien -- rozklad Beta daje realistyczny ksztalt.
    """
    return [round(rng.betavariate(5, 1.8), 3) for _ in range(days)]


def pick_anomaly_windows(start_date: datetime, days: int, rng: random.Random) -> list[AnomalyWindow]:
    """
    Wstrzykuje dwie anomalie -- typowe przypadki z dokumentu:
    - kilka dni ze spadkiem ~35% (np. zabrudzenie paneli)
    - jeden dzien z produkcja bliska zeru (np. awaria falownika)
    """
    windows: list[AnomalyWindow] = []

    if days >= 20:
        soiling_start_offset = rng.randint(5, days - 12)
        soiling_start = start_date + timedelta(days=soiling_start_offset)
        soiling_end = soiling_start + timedelta(days=5)
        windows.append(
            AnomalyWindow(
                start=soiling_start,
                end=soiling_end,
                multiplier=0.62,
                label="zabrudzenie paneli (~-38%, 5 dni)",
            )
        )

        remaining_start = soiling_end + timedelta(days=3)
        if remaining_start < start_date + timedelta(days=days - 2):
            failure_day_offset = rng.randint(0, (start_date + timedelta(days=days - 2) - remaining_start).days)
            failure_day = remaining_start + timedelta(days=failure_day_offset)
            windows.append(
                AnomalyWindow(
                    start=failure_day,
                    end=failure_day + timedelta(days=1),
                    multiplier=0.03,
                    label="awaria falownika (produkcja bliska zeru, 1 dzien)",
                )
            )

    return windows


def multiplier_for(dt: datetime, windows: list[AnomalyWindow]) -> float:
    for w in windows:
        if w.start <= dt < w.end:
            return w.multiplier
    return 1.0


def generate(
    latitude: float,
    peak_power_kwp: float,
    start_date: datetime,
    days: int,
    seed: int | None = None,
) -> tuple[list[dict], list[AnomalyWindow]]:
    rng = random.Random(seed)
    clearness = daily_clearness_indices(days, rng)
    anomaly_windows = pick_anomaly_windows(start_date, days, rng)

    rows: list[dict] = []
    for day_idx in range(days):
        day = start_date + timedelta(days=day_idx)
        day_clearness = clearness[day_idx]

        for hour in range(24):
            ts = day.replace(hour=hour, minute=0, second=0, microsecond=0)
            baseline_kw = clear_sky_power_kw(ts, latitude, peak_power_kwp)
            if baseline_kw <= 0:
                continue

            weather_factor = 0.4 + 0.6 * day_clearness  # nigdy calkiem 0 przy dniu
            noise = rng.gauss(1.0, 0.05)  # drobny szum pomiarowy
            anomaly_mult = multiplier_for(ts, anomaly_windows)

            energy_kwh = max(0.0, baseline_kw * weather_factor * noise * anomaly_mult)

            rows.append({"timestamp": ts.isoformat(), "energy_kwh": round(energy_kwh, 3)})

    return rows, anomaly_windows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lat", type=float, default=50.87, help="Szerokosc geograficzna (domyslnie Kielce)")
    parser.add_argument("--lon", type=float, default=20.63, help="Dlugosc geograficzna (domyslnie Kielce)")
    parser.add_argument("--peak-power", type=float, default=6.5, help="Moc instalacji w kWp")
    parser.add_argument("--start-date", type=str, default="2025-06-01", help="YYYY-MM-DD")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=str, default="synthetic_production.csv")
    args = parser.parse_args()

    start_date = datetime.strptime(args.start_date, "%Y-%m-%d")
    rows, anomaly_windows = generate(
        latitude=args.lat,
        peak_power_kwp=args.peak_power,
        start_date=start_date,
        days=args.days,
        seed=args.seed,
    )

    with open(args.output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["timestamp", "energy_kwh"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Zapisano {len(rows)} godzinowych odczytow do {args.output}")
    print(f"Okres: {start_date.date()} -> {(start_date + timedelta(days=args.days)).date()}")
    print("Wstrzykniete anomalie (do weryfikacji, ze anomaly detection je wylapie):")
    if not anomaly_windows:
        print("  (brak -- za maly zakres dni, zwieksz --days do min. 20)")
    for w in anomaly_windows:
        print(f"  {w.start.date()} -> {w.end.date()}: {w.label}")


if __name__ == "__main__":
    main()
