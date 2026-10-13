"""
Integracja z PVGIS non-interactive API (seriescalc).

Dokumentacja: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en

Endpoint zwraca godzinowe promieniowanie oraz (przy pvcalculation=1) modelowana
moc PV dla podanej lokalizacji i konfiguracji instalacji. Limit: 30 zapytan/s/IP.
"""

from datetime import datetime
from typing import Any

import httpx

# PVGIS 5.3: dane SARAH3 + ERA5, lata 2005-2023
PVGIS_BASE_URL = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc"
PVGIS_MIN_YEAR = 2005
PVGIS_MAX_YEAR = 2023


async def fetch_pvgis_series(
    latitude: float,
    longitude: float,
    peak_power_kwp: float,
    tilt_angle: float,
    azimuth: float,
    losses: float = 14,
    start_year: int | None = None,
    end_year: int | None = None,
) -> list[dict[str, Any]]:
    """
    Pobiera godzinowa serie danych z PVGIS: promieniowanie + modelowana produkcja PV.

    Zwraca liste slownikow: {timestamp, ghi, temp_air, predicted_power_kw, beam_share}
    (timestamp w UTC; beam_share = udzial promieniowania bezposredniego w POA,
    potrzebny do liczenia strat od cienia).

    Uwaga: PVGIS aspect (azymut) liczony jest jako 0 = poludnie, tak samo jak
    nasza konwencja w bazie -- nie trzeba konwertowac.
    """
    params: dict[str, Any] = {
        "lat": latitude,
        "lon": longitude,
        "outputformat": "json",
        "angle": tilt_angle,
        "aspect": azimuth,
        "pvcalculation": 1,
        "peakpower": peak_power_kwp,
        "loss": losses,
        "pvtechchoice": "crystSi",
        "mountingplace": "free",
        "components": 1,
    }
    if start_year:
        params["startyear"] = start_year
    if end_year:
        params["endyear"] = end_year

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(PVGIS_BASE_URL, params=params)
        response.raise_for_status()
        payload = response.json()

    hourly_rows = payload["outputs"]["hourly"]

    results = []
    for row in hourly_rows:
        # PVGIS timestamp format: "20200101:0010" (UTC). Minuta :10 wynika z
        # czasu skanu satelity -- wartosc dotyczy calej godziny, wiec
        # wyrownujemy do pelnej godziny, zeby dalo sie ja laczyc z innymi danymi.
        ts = datetime.strptime(row["time"], "%Y%m%d:%H%M").replace(minute=0)
        beam = row.get("Gb(i)") or 0.0
        poa = beam + (row.get("Gd(i)") or 0.0) + (row.get("Gr(i)") or 0.0)
        results.append(
            {
                "timestamp": ts,
                "ghi": poa if "Gb(i)" in row else row.get("G(i)"),  # promieniowanie na plaszczyznie panelu, W/m2
                "beam_share": beam / poa if poa > 0 else 0.0,
                "temp_air": row.get("T2m"),
                "predicted_power_kw": (row.get("P") or 0) / 1000 if row.get("P") is not None else None,
            }
        )
    return results
