import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.db_models import Installation, WeatherReading
from app.models.schemas import InstallationIn


def create_installation(db: Session, data: InstallationIn) -> Installation:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    installation = Installation(
        id=uuid.uuid4().hex,
        name=data.name,
        latitude=data.latitude,
        longitude=data.longitude,
        peakPowerKwp=data.peak_power_kwp,
        tiltAngle=data.tilt_angle,
        azimuth=data.azimuth,
        losses=data.losses,
        createdAt=now,
        updatedAt=now,
    )
    db.add(installation)
    db.commit()
    db.refresh(installation)
    return installation


def list_installations(db: Session) -> list[Installation]:
    return db.query(Installation).order_by(Installation.createdAt.desc()).all()


def get_installation(db: Session, installation_id: str) -> Installation | None:
    return db.query(Installation).filter(Installation.id == installation_id).first()


def upsert_weather_readings(
    db: Session,
    installation_id: str,
    source: str,
    rows: list[dict],
) -> int:
    """
    Zapisuje godzinowe odczyty pogodowe (timestamp w UTC, poczatek godziny).
    Idempotentne dzieki unikalnemu kluczowi (installationId, timestamp, source)
    zdefiniowanemu w schema.prisma -- ponowne wywolanie ingestion nadpisuje
    istniejace wiersze zamiast je duplikowac.
    """
    if not rows:
        return 0

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    values = [
        {
            "id": uuid.uuid4().hex,
            "installationId": installation_id,
            "timestamp": row["timestamp"],
            "source": source,
            "shortwaveRadiation": _first_not_none(row.get("shortwave_radiation"), row.get("ghi")),
            "tiltedRadiation": row.get("tilted_radiation"),
            "cloudCover": row.get("cloud_cover"),
            "temperature": _first_not_none(row.get("temperature"), row.get("temp_air")),
            "createdAt": now,
        }
        for row in rows
    ]

    # Postgres ogranicza liczbe parametrow w jednym zapytaniu -- dzielimy na paczki.
    for offset in range(0, len(values), 2000):
        stmt = pg_insert(WeatherReading).values(values[offset : offset + 2000])
        stmt = stmt.on_conflict_do_update(
            index_elements=["installationId", "timestamp", "source"],
            set_={
                "shortwaveRadiation": stmt.excluded.shortwaveRadiation,
                "tiltedRadiation": stmt.excluded.tiltedRadiation,
                "cloudCover": stmt.excluded.cloudCover,
                "temperature": stmt.excluded.temperature,
            },
        )
        db.execute(stmt)
    db.commit()
    return len(values)


def _first_not_none(*values):
    # `a or b` gubi poprawne zera (np. 0 W/m2 w nocy, 0 C zima)
    return next((v for v in values if v is not None), None)


HISTORY_SOURCE = "open-meteo-history"
FORECAST_SOURCE = "open-meteo"

TRAINING_QUERY = text(
    """
    SELECT
        p."timestamp" AS timestamp,
        p."energyKwh" AS energy_kwh,
        w."tiltedRadiation" AS poa,
        w."shortwaveRadiation" AS ghi,
        w."temperature" AS temperature,
        w."cloudCover" AS cloud_cover
    FROM production_readings p
    JOIN weather_readings w
        ON w."installationId" = p."installationId"
        AND w."timestamp" = p."timestamp"
        AND w.source = 'open-meteo-history'
    WHERE p."installationId" = :installation_id
        AND w."tiltedRadiation" IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM anomalies a
            WHERE a."installationId" = p."installationId"
                AND p."timestamp" >= a."periodStart"
                AND p."timestamp" < a."periodEnd"
        )
    ORDER BY p."timestamp"
    """
)


def get_training_rows(db: Session, installation_id: str) -> list[dict]:
    """
    Laczy production_readings z pogoda historyczna Open-Meteo z tych samych
    godzin (te same zmienne co w prognozie uzywanej do predykcji). Pomija dni
    z wykrytymi anomaliami, zeby model nie uczyl sie awarii jako normy.
    """
    result = db.execute(TRAINING_QUERY, {"installation_id": installation_id})
    return [dict(row._mapping) for row in result]


MISSING_HISTORY_RANGE_QUERY = text(
    """
    SELECT MIN(p."timestamp") AS start, MAX(p."timestamp") AS end, COUNT(*) AS hours
    FROM production_readings p
    LEFT JOIN weather_readings w
        ON w."installationId" = p."installationId"
        AND w."timestamp" = p."timestamp"
        AND w.source = 'open-meteo-history'
        AND w."tiltedRadiation" IS NOT NULL
    WHERE p."installationId" = :installation_id
        AND w.id IS NULL
    """
)


def get_production_range_without_history(db: Session, installation_id: str) -> tuple[datetime, datetime, int] | None:
    """Zakres produkcji, dla ktorego nie ma jeszcze pogody historycznej (None = wszystko pokryte)."""
    row = db.execute(MISSING_HISTORY_RANGE_QUERY, {"installation_id": installation_id}).one()
    if not row.hours:
        return None
    return row.start, row.end, row.hours


def has_production(db: Session, installation_id: str) -> bool:
    row = db.execute(
        text('SELECT 1 FROM production_readings WHERE "installationId" = :installation_id LIMIT 1'),
        {"installation_id": installation_id},
    ).first()
    return row is not None


UPCOMING_WEATHER_QUERY = text(
    """
    SELECT
        "timestamp" AS timestamp,
        "tiltedRadiation" AS poa,
        "shortwaveRadiation" AS ghi,
        "temperature" AS temperature,
        "cloudCover" AS cloud_cover
    FROM weather_readings
    WHERE "installationId" = :installation_id
        AND source = 'open-meteo'
        AND "timestamp" >= :now
        AND "tiltedRadiation" IS NOT NULL
    ORDER BY "timestamp"
    """
)


def get_upcoming_weather(db: Session, installation_id: str) -> list[dict]:
    """Prognoza pogody (Open-Meteo) od biezacej godziny -- wejscie do predict()."""
    now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    result = db.execute(UPCOMING_WEATHER_QUERY, {"installation_id": installation_id, "now": now})
    return [dict(row._mapping) for row in result]


HISTORY_WITH_PRODUCTION_QUERY = text(
    """
    SELECT
        w."timestamp" AS timestamp,
        w."tiltedRadiation" AS poa,
        w."shortwaveRadiation" AS ghi,
        w."temperature" AS temperature,
        w."cloudCover" AS cloud_cover,
        p."energyKwh" AS energy_kwh
    FROM weather_readings w
    LEFT JOIN production_readings p
        ON p."installationId" = w."installationId"
        AND p."timestamp" = w."timestamp"
    WHERE w."installationId" = :installation_id
        AND w.source = 'open-meteo-history'
        AND w."tiltedRadiation" IS NOT NULL
        AND w."timestamp" >= (
            SELECT MIN("timestamp") FROM production_readings WHERE "installationId" = :installation_id
        )
    ORDER BY w."timestamp"
    """
)


def get_history_with_production(db: Session, installation_id: str) -> list[dict]:
    """
    Godziny pogody historycznej z produkcja (energy_kwh = None, gdy brak
    odczytu) -- do anomaly detection: produkcja vs oczekiwana przy
    rzeczywistej pogodzie.
    """
    result = db.execute(HISTORY_WITH_PRODUCTION_QUERY, {"installation_id": installation_id})
    return [dict(row._mapping) for row in result]


def save_forecasts(db: Session, installation_id: str, model_version: str, predictions: list[dict]) -> int:
    """predictions: lista {timestamp, predicted_kwh}. Upsert po unikalnym kluczu."""
    if not predictions:
        return 0

    from app.db_models import Forecast  # import lokalny, zeby uniknac cyklu na starcie modulu

    values = [
        {
            "id": uuid.uuid4().hex,
            "installationId": installation_id,
            "timestamp": p["timestamp"],
            "predictedKwh": p["predicted_kwh"],
            "modelVersion": model_version,
            "createdAt": datetime.now(timezone.utc).replace(tzinfo=None),
        }
        for p in predictions
    ]

    stmt = pg_insert(Forecast).values(values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["installationId", "timestamp", "modelVersion"],
        set_={"predictedKwh": stmt.excluded.predictedKwh},
    )
    db.execute(stmt)
    db.commit()
    return len(values)


def save_anomalies(db: Session, installation_id: str, anomalies: list[dict]) -> int:
    """
    anomalies: lista {period_start, period_end, deviation_pct, suspected_cause}.
    Upsert po (installationId, periodStart, periodEnd) -- swiadomie NIE
    nadpisuje "status", zeby ponowny skan nie resetowal anomalii juz
    potwierdzonej/rozwiazanej przez uzytkownika z powrotem na "open".
    """
    if not anomalies:
        return 0

    from app.db_models import Anomaly  # import lokalny, zeby uniknac cyklu na starcie modulu

    values = [
        {
            "id": uuid.uuid4().hex,
            "installationId": installation_id,
            "periodStart": a["period_start"],
            "periodEnd": a["period_end"],
            "deviationPct": a["deviation_pct"],
            "suspectedCause": a["suspected_cause"],
            "status": "open",
            "createdAt": datetime.now(timezone.utc).replace(tzinfo=None),
        }
        for a in anomalies
    ]

    stmt = pg_insert(Anomaly).values(values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["installationId", "periodStart", "periodEnd"],
        set_={
            "deviationPct": stmt.excluded.deviationPct,
            "suspectedCause": stmt.excluded.suspectedCause,
        },
    )
    db.execute(stmt)
    db.commit()
    return len(values)


def list_anomalies(db: Session, installation_id: str):
    from app.db_models import Anomaly  # import lokalny, zeby uniknac cyklu na starcie modulu

    return (
        db.query(Anomaly)
        .filter(Anomaly.installationId == installation_id)
        .order_by(Anomaly.periodStart.desc())
        .all()
    )
