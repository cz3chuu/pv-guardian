import asyncio
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query
from sqlalchemy.orm import Session

from app import repository
from app.config import settings
from app.db import SessionLocal, get_db
from app.ml.forecasting import (
    ANOMALY_THRESHOLD_PCT,
    MODEL_VERSION,
    InstallationSpec,
    classify_cause,
    compute_deviation_pct,
    daily_expected_vs_actual,
    detect_anomaly,
    load_model,
    predict_baseline,
    predict_with_model,
    train_and_save_model,
)
from app.models.schemas import (
    AnomalyOut,
    ForecastRequest,
    IngestResult,
    InstallationIn,
    InstallationOut,
    SimulationRequest,
    WeatherPoint,
)
from app.services.open_meteo import MAX_FORECAST_DAYS, MAX_PAST_DAYS, fetch_open_meteo_forecast, fetch_open_meteo_history
from app.services.pvgis import fetch_pvgis_series

automation_state: dict[str, Any] = {
    "enabled": settings.automation_enabled,
    "running": False,
    "last_run": None,
    "last_cycle": None,
    "last_result": None,
    "next_daily_run": None,
    "next_weekly_run": None,
}


async def _scheduler_loop(cycle: str, interval_seconds: int) -> None:
    while True:
        next_run = datetime.now(timezone.utc) + timedelta(seconds=interval_seconds)
        automation_state[f"next_{cycle}_run"] = next_run.isoformat()
        await asyncio.sleep(interval_seconds)
        await _run_cycle(cycle)


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks: list[asyncio.Task] = []
    if settings.automation_enabled:
        tasks = [
            asyncio.create_task(_scheduler_loop("daily", settings.automation_daily_seconds)),
            asyncio.create_task(_scheduler_loop("weekly", settings.automation_weekly_seconds)),
        ]
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="PV Guardian ML Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Instalacje
# ---------------------------------------------------------------------------


@app.post("/installations", response_model=InstallationOut)
def create_installation(data: InstallationIn, db: Session = Depends(get_db)) -> InstallationOut:
    installation = repository.create_installation(db, data)
    return InstallationOut(
        id=installation.id,
        name=installation.name,
        latitude=installation.latitude,
        longitude=installation.longitude,
        peak_power_kwp=installation.peakPowerKwp,
        tilt_angle=installation.tiltAngle,
        azimuth=installation.azimuth,
        losses=installation.losses,
    )


@app.get("/installations", response_model=list[InstallationOut])
def get_installations(db: Session = Depends(get_db)) -> list[InstallationOut]:
    installations = repository.list_installations(db)
    return [
        InstallationOut(
            id=i.id,
            name=i.name,
            latitude=i.latitude,
            longitude=i.longitude,
            peak_power_kwp=i.peakPowerKwp,
            tilt_angle=i.tiltAngle,
            azimuth=i.azimuth,
            losses=i.losses,
        )
        for i in installations
    ]


def _get_installation_or_404(db: Session, installation_id: str):
    installation = repository.get_installation(db, installation_id)
    if installation is None:
        raise HTTPException(status_code=404, detail="Installation not found")
    return installation


# ---------------------------------------------------------------------------
# Ingestion -- pobiera dane pogodowe i ZAPISUJE je do weather_readings
# ---------------------------------------------------------------------------


@app.post("/ingest/pvgis/{installation_id}", response_model=IngestResult)
async def ingest_pvgis(
    installation_id: str,
    start_year: int | None = None,
    end_year: int | None = None,
    db: Session = Depends(get_db),
) -> IngestResult:
    installation = _get_installation_or_404(db, installation_id)

    try:
        rows = await fetch_pvgis_series(
            latitude=installation.latitude,
            longitude=installation.longitude,
            peak_power_kwp=installation.peakPowerKwp,
            tilt_angle=installation.tiltAngle,
            azimuth=installation.azimuth,
            losses=installation.losses,
            start_year=start_year,
            end_year=end_year,
        )
    except Exception as exc:  # noqa: BLE001 - upraszczamy dla szkieletu
        raise HTTPException(status_code=502, detail=f"PVGIS error: {exc}") from exc

    persisted = repository.upsert_weather_readings(db, installation_id, "pvgis", rows)

    return IngestResult(
        installation_id=installation_id,
        source="pvgis",
        points_fetched=len(rows),
        points_persisted=persisted,
    )


@app.post("/ingest/open-meteo/{installation_id}", response_model=IngestResult)
async def ingest_open_meteo(
    installation_id: str,
    forecast_days: int = Query(default=7, ge=1, le=MAX_FORECAST_DAYS),
    past_days: int = Query(default=7, ge=0, le=MAX_PAST_DAYS),
    db: Session = Depends(get_db),
) -> IngestResult:
    """
    Pobiera prognoze Open-Meteo (zapis jako "open-meteo") oraz ostatnie
    past_days dni, ktore zapisuje jako pogode historyczna
    ("open-meteo-history") -- dzieki temu codzienny cykl na biezaco
    uzupelnia dane do treningu i do wykrywania anomalii.
    """
    installation = _get_installation_or_404(db, installation_id)

    try:
        rows = await fetch_open_meteo_forecast(
            latitude=installation.latitude,
            longitude=installation.longitude,
            tilt_angle=installation.tiltAngle,
            azimuth=installation.azimuth,
            forecast_days=forecast_days,
            past_days=past_days,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Open-Meteo error: {exc}") from exc

    current_hour = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    # godzina jest "historyczna", gdy juz sie skonczyla
    past = [r for r in rows if r["timestamp"] + timedelta(hours=1) <= current_hour]
    upcoming = [r for r in rows if r["timestamp"] >= current_hour]
    persisted = repository.upsert_weather_readings(db, installation_id, repository.FORECAST_SOURCE, upcoming)
    persisted += repository.upsert_weather_readings(db, installation_id, repository.HISTORY_SOURCE, past)

    return IngestResult(
        installation_id=installation_id,
        source="open-meteo",
        points_fetched=len(rows),
        points_persisted=persisted,
    )


@app.post("/ingest/open-meteo-history/{installation_id}", response_model=IngestResult)
async def ingest_open_meteo_history(
    installation_id: str,
    start_date: date | None = None,
    end_date: date | None = None,
    db: Session = Depends(get_db),
) -> IngestResult:
    """
    Pobiera godzinowa pogode historyczna (Open-Meteo) dla zakresu dat.
    Bez parametrow: dla okresu wgranej produkcji, ktory nie ma jeszcze pogody.
    """
    installation = _get_installation_or_404(db, installation_id)

    if start_date is None or end_date is None:
        missing = repository.get_production_range_without_history(db, installation_id)
        if missing is None:
            if not repository.has_production(db, installation_id):
                raise HTTPException(status_code=422, detail="Brak produkcji. Najpierw wgraj CSV albo odczyty, potem pobierz dla nich pogode.")
            return IngestResult(installation_id=installation_id, source=repository.HISTORY_SOURCE, points_fetched=0, points_persisted=0)
        start_date = start_date or missing[0].date()
        end_date = end_date or missing[1].date()

    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    end_date = min(end_date, yesterday)
    if end_date < start_date:
        raise HTTPException(status_code=422, detail="Pogoda historyczna jest dostepna najpozniej do wczoraj.")

    try:
        rows = await fetch_open_meteo_history(
            latitude=installation.latitude,
            longitude=installation.longitude,
            tilt_angle=installation.tiltAngle,
            azimuth=installation.azimuth,
            start=start_date,
            end=end_date,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Open-Meteo history error: {exc}") from exc

    persisted = repository.upsert_weather_readings(db, installation_id, repository.HISTORY_SOURCE, rows)
    return IngestResult(
        installation_id=installation_id,
        source=repository.HISTORY_SOURCE,
        points_fetched=len(rows),
        points_persisted=persisted,
    )


# ---------------------------------------------------------------------------
# Prognoza (baseline) i anomaly detection
# ---------------------------------------------------------------------------


@app.post("/forecast")
async def forecast(req: ForecastRequest) -> list[WeatherPoint]:
    """
    Zwraca prognoze produkcji na najblizsze dni.

    Na tym etapie (Faza 0/1) to wprost baseline z PVGIS/seriescalc -- pelny
    model XGBoost wpina sie w Faze 3 w app/ml/forecasting.py::train_model,
    bez zmiany kontraktu tego endpointu. Nie zapisuje jeszcze do tabeli
    forecasts (TODO Faza 3, razem z modelVersion).
    """
    try:
        rows = await fetch_pvgis_series(
            latitude=req.latitude,
            longitude=req.longitude,
            peak_power_kwp=req.peak_power_kwp,
            tilt_angle=req.tilt_angle,
            azimuth=req.azimuth,
            losses=req.losses,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"PVGIS error: {exc}") from exc

    return [
        WeatherPoint(
            timestamp=r["timestamp"],
            source="pvgis-baseline",
            predicted_power_kw=predict_baseline(r["predicted_power_kw"] or 0),
        )
        for r in rows
    ]


# Cache serii PVGIS dla 1 kWp (produkcja skaluje sie liniowo z moca), zeby
# projektant mogl przeliczac warianty bez ponownego pobierania ~5 MB z PVGIS.
_pvgis_cache: dict[tuple, list[dict]] = {}
_PVGIS_CACHE_LIMIT = 64


async def _pvgis_per_kwp(req: SimulationRequest) -> list[dict]:
    key = (round(req.latitude, 3), round(req.longitude, 3), round(req.tilt_angle), round(req.azimuth), round(req.losses, 1), req.start_year, req.end_year)
    if key not in _pvgis_cache:
        rows = await fetch_pvgis_series(
            latitude=req.latitude,
            longitude=req.longitude,
            peak_power_kwp=1.0,
            tilt_angle=req.tilt_angle,
            azimuth=req.azimuth,
            losses=req.losses,
            start_year=req.start_year,
            end_year=req.end_year,
        )
        if len(_pvgis_cache) >= _PVGIS_CACHE_LIMIT:
            _pvgis_cache.pop(next(iter(_pvgis_cache)))
        _pvgis_cache[key] = rows
    return _pvgis_cache[key]


@app.post("/simulate")
async def simulate(req: SimulationRequest) -> dict:
    """
    Symulacja planowanej instalacji na wieloletnich danych PVGIS 5.3, bez odczytow rzeczywistych.

    Oprocz sum zwraca godzinowy profil "typowego roku" (rok o produkcji
    najblizszej sredniej, przeskalowany do sredniej) -- frontend liczy na nim
    bilans godzinowy: autokonsumpcje, magazyn, eksport po cenach RCE i cien.
    """
    if req.end_year < req.start_year:
        raise HTTPException(status_code=422, detail="Rok koncowy nie moze byc wczesniejszy niz poczatkowy")
    try:
        rows = await _pvgis_per_kwp(req)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"PVGIS error: {exc}") from exc

    power = req.peak_power_kwp
    annual: dict[int, float] = {}
    per_year_month: dict[tuple[int, int], float] = {}
    by_year: dict[int, list[dict]] = {}
    for row in rows:
        energy_kwh = float(row.get("predicted_power_kw") or 0.0) * power
        timestamp = row["timestamp"]
        annual[timestamp.year] = annual.get(timestamp.year, 0.0) + energy_kwh
        key = (timestamp.year, timestamp.month)
        per_year_month[key] = per_year_month.get(key, 0.0) + energy_kwh
        by_year.setdefault(timestamp.year, []).append(row)

    monthly: dict[int, list[float]] = {month: [] for month in range(1, 13)}
    for (_, month), value in per_year_month.items():
        monthly[month].append(value)

    average_annual = sum(annual.values()) / len(annual) if annual else 0.0
    monthly_average = [round(sum(monthly[m]) / len(monthly[m]), 1) if monthly[m] else 0.0 for m in range(1, 13)]

    typical_year = min(annual, key=lambda year: abs(annual[year] - average_annual)) if annual else None
    hourly_profile = None
    if typical_year is not None and annual[typical_year] > 0:
        # Kazdy miesiac typowego roku skalujemy do sredniej wieloletniej -- inaczej
        # np. wyjatkowo sloneczny kwiecien tego roku znieksztalcalby rozklad miesieczny.
        year_rows = by_year[typical_year]
        month_scale = {
            m: (monthly_average[m - 1] / per_year_month[(typical_year, m)]) if per_year_month.get((typical_year, m)) else 0.0
            for m in range(1, 13)
        }
        hourly_profile = {
            "year": typical_year,
            "start_utc": year_rows[0]["timestamp"].isoformat() + "Z",
            "kwh": [round(float(r.get("predicted_power_kw") or 0.0) * power * month_scale[r["timestamp"].month], 4) for r in year_rows],
            "beam_share": [round(float(r.get("beam_share") or 0.0), 2) for r in year_rows],
        }

    consumption = req.annual_consumption_kwh
    return {
        "source": "PVGIS 5.3 (SARAH3)",
        "period": {"start_year": req.start_year, "end_year": req.end_year, "years": len(annual)},
        "installation": {"peak_power_kwp": power, "tilt_angle": req.tilt_angle, "azimuth": req.azimuth, "losses": req.losses},
        "average_annual_kwh": round(average_annual, 1),
        "specific_yield_kwh_per_kwp": round(average_annual / power, 1),
        "monthly_kwh": monthly_average,
        "annual_variants_kwh": {str(year): round(value, 1) for year, value in sorted(annual.items())},
        "annual_consumption_kwh": consumption,
        "production_to_consumption_pct": round(average_annual / consumption * 100, 1) if consumption else None,
        "hourly_profile": hourly_profile,
        "disclaimer": "Produkcja z PVGIS 5.3 (srednia z lat podanych wyzej). Nie uwzglednia lokalnego zacienienia (liczonego osobno w projektancie), sniegu ani przerw serwisowych.",
    }


@app.get("/anomalies/check")
async def check_anomaly(predicted_kwh: float, actual_kwh: float) -> dict:
    """Szybki test progu anomalii dla pojedynczego punktu, bez pelnego pipeline'u i klasyfikacji przyczyny."""
    result = detect_anomaly(predicted_kwh, actual_kwh)
    return {"anomaly": result}


@app.get("/installations/{installation_id}/anomalies", response_model=list[AnomalyOut])
def get_anomalies(installation_id: str, db: Session = Depends(get_db)) -> list[AnomalyOut]:
    _get_installation_or_404(db, installation_id)
    anomalies = repository.list_anomalies(db, installation_id)
    return [
        AnomalyOut(
            id=a.id,
            period_start=a.periodStart,
            period_end=a.periodEnd,
            deviation_pct=a.deviationPct,
            suspected_cause=a.suspectedCause,
            status=a.status,
        )
        for a in anomalies
    ]


def _scan_and_persist_anomalies(db: Session, installation_id: str, bundle: dict, spec: InstallationSpec) -> int:
    """
    Porownuje dzienna produkcje z produkcja OCZEKIWANA PRZY RZECZYWISTEJ
    POGODZIE (pogoda historyczna Open-Meteo), a nie z prognoza sprzed kilku
    dni -- inaczej kazdy blad prognozy pogody (np. zapowiadane slonce, a
    przyszly chmury) wygladalby jak awaria instalacji.
    """
    daily_rows = daily_expected_vs_actual(repository.get_history_with_production(db, installation_id), bundle, spec)

    anomalies: list[dict] = []
    deviation_history: list[float] = []
    for row in daily_rows:
        deviation_pct = compute_deviation_pct(row["predicted_kwh"], row["actual_kwh"])
        if deviation_pct is None:
            continue

        if deviation_pct <= ANOMALY_THRESHOLD_PCT:
            cause = classify_cause(deviation_pct, row["avg_cloud_cover"], row["avg_temperature"], deviation_history)
            anomalies.append(
                {
                    "period_start": row["period_start"],
                    "period_end": row["period_end"],
                    "deviation_pct": deviation_pct,
                    "suspected_cause": cause,
                }
            )

        deviation_history.append(deviation_pct)

    return repository.save_anomalies(db, installation_id, anomalies)


# ---------------------------------------------------------------------------
# Trening i predykcja modelem XGBoost (Faza 3)
# ---------------------------------------------------------------------------


@app.post("/train/{installation_id}")
def train(installation_id: str, db: Session = Depends(get_db)) -> dict:
    """
    Trenuje model XGBoost dla danej instalacji na podstawie wgranego CSV
    (production_readings) polaczonego z pogoda historyczna Open-Meteo
    (weather_readings). Wymaga, zeby oba zrodla pokrywaly ten sam okres --
    brakujaca pogode historyczna pobiera POST /ingest/open-meteo-history/{id}.
    """
    installation = _get_installation_or_404(db, installation_id)

    rows = repository.get_training_rows(db, installation_id)
    try:
        metrics = train_and_save_model(installation_id, rows, InstallationSpec.from_installation(installation))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return metrics


@app.get("/installations/{installation_id}/model-analysis")
def model_analysis(installation_id: str, db: Session = Depends(get_db)) -> dict:
    _get_installation_or_404(db, installation_id)
    bundle = load_model(installation_id)
    if bundle is None:
        raise HTTPException(status_code=404, detail="Brak wytrenowanego modelu. Najpierw uruchom trening.")
    # Analiza jest liczona przy treningu na odlozonym zbiorze testowym -- model
    # produkcyjny jest potem douczany na wszystkich danych, wiec liczenie
    # bledow na nim teraz oznaczaloby test na danych treningowych.
    return {
        **bundle["analysis"],
        "trained_until": bundle["trained_until"].isoformat(),
        "time_alignment": bundle["time_alignment"],
    }


@app.get("/predict/{installation_id}")
def predict(
    installation_id: str,
    persist: bool = True,
    detect_anomalies: bool = True,
    db: Session = Depends(get_db),
) -> dict:
    """
    Prognozuje produkcje na najblizsze dni (na podstawie zaimportowanej
    prognozy pogody z Open-Meteo) uzywajac wytrenowanego modelu danej
    instalacji. Domyslnie zapisuje wyniki do tabeli forecasts.

    Domyslnie odpala tez anomaly detection: porownuje rzeczywista produkcje
    z produkcja oczekiwana przy rzeczywistej (historycznej) pogodzie i
    zapisuje wykryte anomalie do tabeli anomalies. To dziala niezaleznie od
    prognozy generowanej w tym wywolaniu -- /predict jest po prostu
    wygodnym miejscem, zeby to przy okazji odpalac.
    """
    installation = _get_installation_or_404(db, installation_id)
    spec = InstallationSpec.from_installation(installation)

    bundle = load_model(installation_id)
    if bundle is None:
        raise HTTPException(
            status_code=404,
            detail="Brak wytrenowanego modelu dla tej instalacji. Wywolaj najpierw POST /train/{installation_id}.",
        )

    weather_rows = repository.get_upcoming_weather(db, installation_id)
    if not weather_rows:
        raise HTTPException(
            status_code=422,
            detail="Brak zaimportowanej prognozy pogody. Wywolaj najpierw POST /ingest/open-meteo/{installation_id}.",
        )

    predicted_values = predict_with_model(bundle, weather_rows, spec)
    predictions = [
        {"timestamp": row["timestamp"], "predicted_kwh": value}
        for row, value in zip(weather_rows, predicted_values)
    ]

    persisted = 0
    if persist:
        persisted = repository.save_forecasts(db, installation_id, MODEL_VERSION, predictions)

    anomalies_detected = 0
    if detect_anomalies:
        anomalies_detected = _scan_and_persist_anomalies(db, installation_id, bundle, spec)

    return {
        "installation_id": installation_id,
        "model_version": MODEL_VERSION,
        "predictor": bundle["predictor"],
        "points": len(predictions),
        "persisted": persisted,
        "anomalies_detected": anomalies_detected,
        "predictions": predictions,
    }


# ---------------------------------------------------------------------------
# Automatyzacja i przyjazne akcje dla panelu webowego
# ---------------------------------------------------------------------------


def _json_result(value: Any) -> Any:
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


async def _ingest_forecast(installation_id: str, db: Session) -> IngestResult:
    return await ingest_open_meteo(installation_id, forecast_days=7, past_days=7, db=db)


def _predict_default(installation_id: str, db: Session) -> dict:
    return predict(installation_id, persist=True, detect_anomalies=True, db=db)


async def _execute_action(action: str, installation_id: str, db: Session) -> dict:
    # Trening i predykcja to ciezkie obliczenia (pandas/XGBoost) -- odpalamy je w
    # osobnym watku, zeby nie blokowac event loopa (i np. /health) na czas treningu.
    if action == "history":
        return {"action": action, "result": _json_result(await ingest_open_meteo_history(installation_id, db=db))}
    if action == "weather":
        return {"action": action, "result": _json_result(await _ingest_forecast(installation_id, db))}
    if action == "train":
        return {"action": action, "result": await asyncio.to_thread(train, installation_id, db)}
    if action == "predict":
        return {"action": action, "result": await asyncio.to_thread(_predict_default, installation_id, db)}
    if action == "analysis":
        return {"action": action, "result": model_analysis(installation_id, db=db)}
    if action == "refresh":
        weather = await _ingest_forecast(installation_id, db)
        prediction = await asyncio.to_thread(_predict_default, installation_id, db)
        return {"action": action, "result": {"weather": _json_result(weather), "prediction": prediction}}
    raise HTTPException(status_code=400, detail="Nieznana operacja")


async def _run_cycle(cycle: str) -> dict:
    if automation_state["running"]:
        return {"cycle": cycle, "skipped": True, "reason": "Inny cykl jest w toku"}
    automation_state["running"] = True
    db = SessionLocal()
    results: list[dict] = []
    try:
        for installation in repository.list_installations(db):
            try:
                if cycle == "weekly":
                    await _execute_action("history", installation.id, db)
                    await _execute_action("train", installation.id, db)
                result = await _execute_action("refresh", installation.id, db)
                results.append({"installation_id": installation.id, "ok": True, "result": result})
            except Exception as exc:  # jedna niegotowa instalacja nie zatrzymuje pozostalych
                db.rollback()
                results.append({"installation_id": installation.id, "ok": False, "error": str(exc)})
        summary = {"cycle": cycle, "installations": len(results), "succeeded": sum(r["ok"] for r in results), "results": results}
        automation_state.update(last_run=datetime.now(timezone.utc).isoformat(), last_cycle=cycle, last_result=summary)
        return summary
    finally:
        automation_state["running"] = False
        db.close()


@app.get("/automation/status")
def automation_status() -> dict:
    return {**automation_state, "daily_interval_seconds": settings.automation_daily_seconds, "weekly_interval_seconds": settings.automation_weekly_seconds}


@app.post("/automation/run/{cycle}")
async def run_automation_cycle(cycle: str) -> dict:
    if cycle not in {"daily", "weekly"}:
        raise HTTPException(status_code=400, detail="Cykl musi miec wartosc daily albo weekly")
    return await _run_cycle(cycle)


@app.post("/installations/{installation_id}/actions/{action}")
async def run_installation_action(installation_id: str, action: str, db: Session = Depends(get_db)) -> dict:
    _get_installation_or_404(db, installation_id)
    try:
        return await _execute_action(action, installation_id, db)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
