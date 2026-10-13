"""
Integracja z Open-Meteo: prognoza (Forecast API) i dane historyczne
(Historical Forecast API od 2022 r., Historical Weather / ERA5 wczesniej).

Dokumentacja: https://open-meteo.com/en/docs
Darmowe do 10 000 zapytan/dzien (non-commercial), bez klucza API.

Konwencje (wspolne dla calego projektu):
- wszystkie znaczniki czasu sa w UTC (naiwne datetime, tak jak zapisuje je Prisma),
- znacznik oznacza POCZATEK godziny, ktorej dotyczy wartosc (10:00 = energia
  z przedzialu 10:00-11:00), tak samo jak w production_readings.

Open-Meteo podaje promieniowanie jako srednia z POPRZEDZAJACEJ godziny
(wartosc o 11:00 = srednia 10:00-11:00), wiec przesuwamy je o godzine wstecz.
Temperatura i zachmurzenie sa chwilowe -- bierzemy srednia z poczatku i konca
przedzialu.

Uzywamy global_tilted_irradiance (promieniowanie na plaszczyznie paneli dla
podanego nachylenia i azymutu) -- ta sama wielkosc w treningu i w predykcji.
Azymut w Open-Meteo: 0 = poludnie, -90 = wschod, 90 = zachod (jak w PVGIS).
"""

from datetime import date, datetime, timedelta
from typing import Any

import httpx

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HISTORICAL_FORECAST_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Historical Forecast API ma dane z modeli prognostycznych (te same co w prognozie)
# od ok. 2022 r.; wczesniejsze okresy bierzemy z reanalizy ERA5 (Archive API).
HISTORICAL_FORECAST_START = date(2022, 1, 1)
MAX_FORECAST_DAYS = 16
MAX_PAST_DAYS = 92

HOURLY_VARIABLES = [
    "shortwave_radiation",
    "global_tilted_irradiance",
    "cloud_cover",
    "temperature_2m",
]


def _mean(a: float | None, b: float | None) -> float | None:
    values = [v for v in (a, b) if v is not None]
    return sum(values) / len(values) if values else None


def parse_hourly_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Zamienia odpowiedz Open-Meteo (timezone=UTC) na wiersze z konwencja
    "poczatek godziny". Ostatni punkt odpowiedzi jest odrzucany, bo nie ma dla
    niego wartosci z kolejnej godziny.
    """
    hourly = payload["hourly"]
    times = [datetime.fromisoformat(t) for t in hourly["time"]]
    ghi = hourly["shortwave_radiation"]
    poa = hourly["global_tilted_irradiance"]
    cloud = hourly["cloud_cover"]
    temp = hourly["temperature_2m"]

    rows = []
    for idx in range(len(times) - 1):
        if times[idx + 1] - times[idx] != timedelta(hours=1):
            continue
        rows.append(
            {
                "timestamp": times[idx],
                "shortwave_radiation": ghi[idx + 1],
                "tilted_radiation": poa[idx + 1],
                "cloud_cover": _mean(cloud[idx], cloud[idx + 1]),
                "temperature": _mean(temp[idx], temp[idx + 1]),
            }
        )
    return rows


def _base_params(latitude: float, longitude: float, tilt_angle: float, azimuth: float) -> dict[str, Any]:
    return {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": ",".join(HOURLY_VARIABLES),
        "tilt": tilt_angle,
        "azimuth": azimuth,
        "timezone": "UTC",
    }


async def _get(url: str, params: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        return response.json()


async def fetch_open_meteo_forecast(
    latitude: float,
    longitude: float,
    tilt_angle: float,
    azimuth: float,
    forecast_days: int = 7,
    past_days: int = 0,
) -> list[dict[str, Any]]:
    """
    Pobiera godzinowa prognoze (do 16 dni) oraz opcjonalnie ostatnie dni
    (past_days) -- przeszle godziny to najlepsze dostepne odtworzenie pogody,
    ktore wywolujacy zapisuje jako dane historyczne.
    """
    params = _base_params(latitude, longitude, tilt_angle, azimuth)
    params["forecast_days"] = max(1, min(MAX_FORECAST_DAYS, forecast_days))
    params["past_days"] = max(0, min(MAX_PAST_DAYS, past_days))
    return parse_hourly_payload(await _get(FORECAST_URL, params))


async def fetch_open_meteo_history(
    latitude: float,
    longitude: float,
    tilt_angle: float,
    azimuth: float,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    """
    Pobiera godzinowa pogode historyczna dla zakresu dat [start, end] (UTC),
    dzielac go na kawalki po maksymalnie roku.
    """
    rows: list[dict[str, Any]] = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(end, chunk_start + timedelta(days=365))
        url = HISTORICAL_FORECAST_URL if chunk_start >= HISTORICAL_FORECAST_START else ARCHIVE_URL
        if url == ARCHIVE_URL and chunk_end >= HISTORICAL_FORECAST_START:
            chunk_end = HISTORICAL_FORECAST_START - timedelta(days=1)

        params = _base_params(latitude, longitude, tilt_angle, azimuth)
        params["start_date"] = chunk_start.isoformat()
        # +1 dzien, bo przesuniecie promieniowania zjada ostatnia godzine
        params["end_date"] = (chunk_end + timedelta(days=1)).isoformat()
        chunk_rows = parse_hourly_payload(await _get(url, params))

        upper = datetime.combine(chunk_end + timedelta(days=1), datetime.min.time())
        lower = datetime.combine(chunk_start, datetime.min.time())
        rows.extend(r for r in chunk_rows if lower <= r["timestamp"] < upper and r["tilted_radiation"] is not None)
        chunk_start = chunk_end + timedelta(days=1)
    return rows
