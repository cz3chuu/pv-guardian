"""
Model prognozujacy produkcje PV.

Pipeline:
- dane treningowe = produkcja rzeczywista (CSV upload) polaczona z pogoda
  historyczna Open-Meteo z tych samych godzin (repository.get_training_rows),
- predykcja = ten sam zestaw zmiennych z prognozy Open-Meteo, wiec model
  dostaje w predykcji dokladnie to samo, na czym byl trenowany,
- wszystkie znaczniki czasu sa w UTC i oznaczaja poczatek godziny.

Model jest "fizyczny + korekta":
1. Model fizyczny liczy energie oczekiwana z promieniowania na plaszczyznie
   paneli (POA), mocy, strat i temperatury ogniw.
2. XGBoost uczy sie wspolczynnika korekty (rzeczywista / oczekiwana) w
   zaleznosci od polozenia slonca, zachmurzenia, temperatury itp. -- to
   wylapuje lokalne zacienienie, odbicia, niedokladnosci modelu pogody.

Dzieki temu model nie "obcina" produkcji do maksimum widzianego w treningu
(drzewa nie ekstrapoluja), wiec trening na kilku tygodniach wiosny daje
sensowna prognoze latem. Gdy danych jest malo albo XGBoost przegrywa na
zbiorze testowym, uzywany jest skalibrowany model fizyczny.
"""

from dataclasses import dataclass
from datetime import datetime
from math import ceil, sqrt
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor

MODELS_DIR = Path(__file__).resolve().parent.parent / "trained_models"
MODELS_DIR.mkdir(exist_ok=True)

MODEL_VERSION = "xgboost-v3"
FEATURE_COLUMNS = ["poa", "ghi", "clearness", "poa_to_ghi", "temperature", "cloud_cover", "sun_elevation", "sun_azimuth"]
MIN_TRAINING_ROWS = 50  # godziny dzienne po odfiltrowaniu awarii
MIN_ML_ROWS = 300  # ponizej tego XGBoost nie ma szans pobic modelu fizycznego
DAYLIGHT_THRESHOLD = 0.02  # godzina "dzienna", gdy oczekiwana energia >= 2% mocy szczytowej
MAX_RATIO = 1.5
LOCAL_TIMEZONE = "Europe/Warsaw"


@dataclass
class InstallationSpec:
    latitude: float
    longitude: float
    peak_power_kwp: float
    losses: float
    tilt_angle: float
    azimuth: float

    @classmethod
    def from_installation(cls, installation: Any) -> "InstallationSpec":
        return cls(
            latitude=installation.latitude,
            longitude=installation.longitude,
            peak_power_kwp=installation.peakPowerKwp,
            losses=installation.losses,
            tilt_angle=installation.tiltAngle,
            azimuth=installation.azimuth,
        )


def predict_baseline(pvgis_predicted_power_kw: float) -> float:
    """Najprostszy baseline: bierzemy wprost prognoze z PVGIS."""
    return pvgis_predicted_power_kw


def _model_path(installation_id: str) -> Path:
    return MODELS_DIR / f"{installation_id}.{MODEL_VERSION}.joblib"


# ---------------------------------------------------------------------------
# Cechy
# ---------------------------------------------------------------------------


def solar_position(timestamps: pd.Series, latitude: float, longitude: float) -> tuple[np.ndarray, np.ndarray]:
    """
    Wysokosc i azymut slonca (stopnie, azymut 0 = poludnie, + = zachod) w
    srodku godziny zaczynajacej sie od timestamp (UTC). Algorytm NOAA,
    dokladnosc ok. 0.5 stopnia -- wystarczajaca jako cecha modelu.
    """
    t = pd.to_datetime(timestamps) + pd.Timedelta(minutes=30)
    day_of_year = t.dt.dayofyear.to_numpy()
    hour = (t.dt.hour + t.dt.minute / 60).to_numpy()
    gamma = 2 * np.pi / 365 * (day_of_year - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (
        0.000075 + 0.001868 * np.cos(gamma) - 0.032077 * np.sin(gamma)
        - 0.014615 * np.cos(2 * gamma) - 0.040849 * np.sin(2 * gamma)
    )
    decl = (
        0.006918 - 0.399912 * np.cos(gamma) + 0.070257 * np.sin(gamma)
        - 0.006758 * np.cos(2 * gamma) + 0.000907 * np.sin(2 * gamma)
        - 0.002697 * np.cos(3 * gamma) + 0.00148 * np.sin(3 * gamma)
    )
    true_solar_minutes = hour * 60 + eqtime + 4 * longitude
    hour_angle = np.radians(true_solar_minutes / 4 - 180)
    lat = np.radians(latitude)
    cos_zenith = np.clip(np.sin(lat) * np.sin(decl) + np.cos(lat) * np.cos(decl) * np.cos(hour_angle), -1, 1)
    elevation = 90 - np.degrees(np.arccos(cos_zenith))
    azimuth = np.degrees(np.arctan2(np.sin(hour_angle), np.cos(hour_angle) * np.sin(lat) - np.tan(decl) * np.cos(lat)))
    return elevation, azimuth


def physical_expected_kwh(poa: pd.Series, temperature: pd.Series, spec: InstallationSpec) -> pd.Series:
    """Energia w godzinie z modelu fizycznego: moc * POA/1000 * (1 - straty) * wspolczynnik temperaturowy."""
    poa = poa.clip(lower=0)
    cell_temperature = temperature + 0.03 * poa  # ~NOCT 45 C
    temperature_factor = (1 - 0.004 * (cell_temperature - 25)).clip(0.75, 1.15)
    return spec.peak_power_kwp * poa / 1000 * (1 - spec.losses / 100) * temperature_factor


def build_features(rows: list[dict[str, Any]], spec: InstallationSpec) -> pd.DataFrame:
    """
    Buduje macierz cech z wierszy {timestamp, poa, ghi, temperature,
    cloud_cover[, energy_kwh]}. Zachowuje kolejnosc wierszy.
    """
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df["timestamp"] = pd.to_datetime(df["timestamp"])
    defaults = {"poa": 0.0, "ghi": 0.0, "temperature": 10.0, "cloud_cover": 50.0}
    for col, default in defaults.items():
        if col not in df.columns:
            df[col] = np.nan
        df[col] = pd.to_numeric(df[col], errors="coerce")
        fill_value = df[col].mean() if df[col].notna().any() else default
        df[col] = df[col].fillna(fill_value)
    df["poa"] = df["poa"].clip(lower=0)
    df["ghi"] = df["ghi"].clip(lower=0)

    elevation, azimuth = solar_position(df["timestamp"], spec.latitude, spec.longitude)
    df["sun_elevation"] = elevation
    df["sun_azimuth"] = azimuth
    cos_zenith = np.sin(np.radians(np.clip(elevation, 0, 90)))
    # clear-sky GHI wg Haurwitza -- clearness ~1 przy bezchmurnym niebie
    clear_sky_ghi = np.where(cos_zenith > 0.02, 1098 * cos_zenith * np.exp(-0.057 / np.maximum(cos_zenith, 0.02)), 0)
    df["clearness"] = np.where(clear_sky_ghi > 10, np.clip(df["ghi"] / np.maximum(clear_sky_ghi, 1), 0, 1.5), 0)
    df["poa_to_ghi"] = np.where(df["ghi"] > 10, np.clip(df["poa"] / np.maximum(df["ghi"], 1), 0, 5), 0)
    df["expected_kwh"] = physical_expected_kwh(df["poa"], df["temperature"], spec)
    return df


def _daylight_mask(df: pd.DataFrame, spec: InstallationSpec) -> pd.Series:
    return df["expected_kwh"] >= DAYLIGHT_THRESHOLD * spec.peak_power_kwp


def _outlier_mask(df: pd.DataFrame, spec: InstallationSpec) -> pd.Series:
    """
    Godziny, ktore psuja trening: zero przy duzym naslonecznieniu (awaria,
    wylaczenie, snieg, dziura w danych) albo produkcja kilka razy wieksza niz
    fizycznie mozliwa (blad danych / przesuniecie czasu).
    """
    expected = df["expected_kwh"]
    ratio = df["energy_kwh"] / expected.where(expected > 0)
    outage = (expected >= 0.1 * spec.peak_power_kwp) & (ratio < 0.05)
    impossible = (expected >= DAYLIGHT_THRESHOLD * spec.peak_power_kwp) & (ratio > 2.5)
    above_capacity = df["energy_kwh"] > spec.peak_power_kwp * 1.1
    return (outage | impossible | above_capacity).fillna(False)


def check_time_alignment(df: pd.DataFrame) -> dict[str, Any]:
    """
    Sprawdza, czy produkcja jest zgrana w czasie z pogoda: liczy korelacje
    produkcji z energia oczekiwana przesunieta o -3..+3 h. Jesli najlepsza
    jest inna niz 0, dane CSV maja najpewniej zla strefe czasowa albo
    znacznik oznacza koniec, a nie poczatek godziny.
    """
    actual = df.set_index("timestamp")["energy_kwh"]
    expected = df.set_index("timestamp")["expected_kwh"]
    correlations: dict[int, float] = {}
    for shift in range(-3, 4):
        # shift=+1: produkcja z 11:00 pasuje do pogody z 10:00 (produkcja "spozniona" o godzine)
        shifted = expected.shift(shift, freq="h")
        joined = pd.concat([actual, shifted], axis=1, join="inner").dropna()
        if len(joined) > 24 and joined.iloc[:, 0].std() > 0 and joined.iloc[:, 1].std() > 0:
            correlations[shift] = float(joined.iloc[:, 0].corr(joined.iloc[:, 1]))
    if not correlations:
        return {"best_shift_hours": None, "correlation": None, "warning": None}
    best = max(correlations, key=correlations.get)
    at_zero = correlations.get(0)
    warning = None
    if best != 0 and (at_zero is None or correlations[best] - at_zero > 0.02):
        warning = (
            f"Produkcja wyglada na przesunieta o {best:+d} h wzgledem pogody "
            f"(korelacja {correlations[best]:.2f} zamiast {at_zero if at_zero is not None else float('nan'):.2f}). "
            "Sprawdz strefe czasowa pliku CSV i czy znacznik czasu oznacza poczatek godziny."
        )
    return {
        "best_shift_hours": best,
        "correlation": round(correlations[best], 3),
        "correlation_at_zero": round(at_zero, 3) if at_zero is not None else None,
        "warning": warning,
    }


# ---------------------------------------------------------------------------
# Trening
# ---------------------------------------------------------------------------


def _monthly_blocked_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Ostatnie 20% kazdego miesiaca trafia do testu, aby zachowac reprezentacje sezonow."""
    ordered = df.sort_values("timestamp").reset_index(drop=True)
    test_indices: list[int] = []
    periods = ordered["timestamp"].dt.to_period("M")
    for period in periods.unique():
        indices = ordered.index[periods == period].tolist()
        test_indices.extend(indices[-max(1, ceil(len(indices) * 0.2)):])
    test = ordered.loc[sorted(test_indices)].copy()
    train = ordered.drop(index=test_indices).copy()
    return train, test


def _calibration_factor(df: pd.DataFrame) -> float:
    """Stosunek sumy produkcji do sumy energii oczekiwanej (sprawnosc calej instalacji wzgledem modelu)."""
    expected = df["expected_kwh"].sum()
    return float(df["energy_kwh"].sum() / expected) if expected > 0 else 1.0


def _fit_ratio_model(daylight: pd.DataFrame) -> XGBRegressor:
    ratio = (daylight["energy_kwh"] / daylight["expected_kwh"]).clip(0, MAX_RATIO)
    weights = daylight["expected_kwh"] / daylight["expected_kwh"].mean()
    model = XGBRegressor(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.9,
        min_child_weight=5,
        random_state=42,
    )
    model.fit(daylight[FEATURE_COLUMNS], ratio, sample_weight=weights)
    return model


def _predict_frame(df: pd.DataFrame, bundle: dict[str, Any], spec: InstallationSpec, predictor: str | None = None) -> np.ndarray:
    predictor = predictor or bundle["predictor"]
    ratio = np.full(len(df), bundle["calibration"])
    if predictor == "ml" and bundle.get("model") is not None and len(df):
        daylight = _daylight_mask(df, spec).to_numpy()
        if daylight.any():
            ratio[daylight] = np.clip(bundle["model"].predict(df.loc[daylight, FEATURE_COLUMNS]), 0, MAX_RATIO)
    return np.clip(df["expected_kwh"].to_numpy() * ratio, 0, spec.peak_power_kwp * 1.05)


def train_and_save_model(installation_id: str, rows: list[dict[str, Any]], spec: InstallationSpec) -> dict[str, Any]:
    """
    Trenuje model korekty dla danej instalacji, wybiera lepszy z (XGBoost,
    skalibrowany model fizyczny) na zbiorze testowym, a potem dotrenowuje
    wybrany na wszystkich danych i zapisuje na dysk razem z analiza bledow.
    """
    df = build_features(rows, spec)
    if df.empty:
        raise ValueError(
            "Brak danych do treningu: nie ma godzin, dla ktorych istnieje jednoczesnie produkcja i pogoda historyczna. "
            "Wgraj produkcje i uruchom 'Pobierz dane historyczne'."
        )
    df = df.dropna(subset=["energy_kwh"])
    alignment = check_time_alignment(df)

    outliers = _outlier_mask(df, spec)
    clean = df[~outliers]
    daylight_rows = int(_daylight_mask(clean, spec).sum())
    if daylight_rows < MIN_TRAINING_ROWS:
        message = (
            f"Za malo danych do treningu: {daylight_rows} godzin dziennych z pogoda historyczna "
            f"(minimum {MIN_TRAINING_ROWS}, odrzucono {int(outliers.sum())} godzin jako awarie/bledy danych)."
        )
        if alignment.get("warning"):
            message += " " + alignment["warning"]
        raise ValueError(message)

    train_df, test_df = _monthly_blocked_split(clean)
    train_daylight = train_df[_daylight_mask(train_df, spec)]
    holdout_bundle = {
        "calibration": _calibration_factor(train_daylight),
        "model": _fit_ratio_model(train_daylight) if len(train_daylight) >= MIN_TRAINING_ROWS else None,
        "predictor": "ml",
    }
    test_df["actual"] = test_df["energy_kwh"]
    test_df["baseline"] = _predict_frame(test_df, holdout_bundle, spec, predictor="baseline")
    test_df["ml"] = _predict_frame(test_df, holdout_bundle, spec, predictor="ml")
    analysis = _analysis(test_df)

    ml_mae = analysis["hourly"]["ml"]["mae_kwh"]
    baseline_mae = analysis["hourly"]["baseline"]["mae_kwh"]
    enough_for_ml = len(train_daylight) >= MIN_ML_ROWS
    predictor = "ml" if enough_for_ml and ml_mae is not None and baseline_mae is not None and ml_mae < baseline_mae else "baseline"
    analysis["winner"] = "ml" if ml_mae is not None and baseline_mae is not None and ml_mae < baseline_mae else "baseline"
    analysis["predictor"] = predictor
    if not enough_for_ml:
        analysis["methodology"] += f" Za malo danych dla XGBoost ({len(train_daylight)} < {MIN_ML_ROWS} godzin), prognozy uzywaja modelu fizycznego."

    # Model produkcyjny uczony na wszystkich czystych danych.
    all_daylight = clean[_daylight_mask(clean, spec)]
    trained_until = clean["timestamp"].max().to_pydatetime()
    bundle = {
        "model_version": MODEL_VERSION,
        "predictor": predictor,
        "calibration": _calibration_factor(all_daylight),
        "model": _fit_ratio_model(all_daylight) if predictor == "ml" else None,
        "trained_until": trained_until,
        "trained_at": datetime.utcnow(),
        "analysis": analysis,
        "time_alignment": alignment,
    }
    joblib.dump(bundle, _model_path(installation_id))

    chosen = analysis["hourly"][predictor]
    return {
        "rows_used": len(clean),
        "daylight_rows": len(all_daylight),
        "excluded_outliers": int(outliers.sum()),
        "train_rows": len(train_df),
        "test_rows": len(test_df),
        "predictor": predictor,
        "mae_kwh": chosen["mae_kwh"],
        "r2": chosen["r2"],
        "ml_mae_kwh": ml_mae,
        "baseline_mae_kwh": baseline_mae,
        "calibration_factor": round(bundle["calibration"], 3),
        "trained_until": trained_until.isoformat(),
        "time_alignment": alignment,
        "model_version": MODEL_VERSION,
        "split": "monthly-blocked-80-20",
    }


def load_model(installation_id: str) -> dict[str, Any] | None:
    path = _model_path(installation_id)
    if not path.exists():
        return None
    return joblib.load(path)


def predict_with_model(bundle: dict[str, Any], rows: list[dict[str, Any]], spec: InstallationSpec) -> list[float]:
    df = build_features(rows, spec)
    if df.empty:
        return []
    return [round(float(v), 4) for v in _predict_frame(df, bundle, spec)]


# ---------------------------------------------------------------------------
# Analiza bledow (liczona przy treningu na zbiorze testowym)
# ---------------------------------------------------------------------------


def _metrics(actual: list[float], predicted: list[float]) -> dict[str, float | int | None]:
    if not actual:
        return {"points": 0, "mae_kwh": None, "rmse_kwh": None, "mape_pct": None, "r2": None, "bias_kwh": None}
    non_zero = [(a, p) for a, p in zip(actual, predicted) if a > 0.05]
    mape = sum(abs((a - p) / a) for a, p in non_zero) / len(non_zero) * 100 if non_zero else None
    return {
        "points": len(actual),
        "mae_kwh": round(float(mean_absolute_error(actual, predicted)), 3),
        "rmse_kwh": round(sqrt(float(mean_squared_error(actual, predicted))), 3),
        "mape_pct": round(mape, 2) if mape is not None else None,
        "r2": round(float(r2_score(actual, predicted)), 3) if len(actual) > 1 else None,
        "bias_kwh": round(sum(p - a for a, p in zip(actual, predicted)) / len(actual), 3),
    }


MONTH_NAMES = ["styczen", "luty", "marzec", "kwiecien", "maj", "czerwiec", "lipiec", "sierpien", "wrzesien", "pazdziernik", "listopad", "grudzien"]
SEASONS = {12: "zima", 1: "zima", 2: "zima", 3: "wiosna", 4: "wiosna", 5: "wiosna", 6: "lato", 7: "lato", 8: "lato", 9: "jesien", 10: "jesien", 11: "jesien"}


def _analysis(test: pd.DataFrame) -> dict[str, Any]:
    """Porownuje skalibrowany model fizyczny i XGBoost na zbiorze testowym (kolumny actual/baseline/ml)."""

    def pair(frame: pd.DataFrame) -> dict[str, Any]:
        actual = frame["actual"].tolist()
        return {"baseline": _metrics(actual, frame["baseline"].tolist()), "ml": _metrics(actual, frame["ml"].tolist())}

    daily = test.set_index("timestamp")[["actual", "baseline", "ml"]].resample("D").sum()
    daily = daily[daily["actual"] > 0]
    monthly = [
        {"month": int(month), "label": MONTH_NAMES[int(month) - 1], **pair(group)}
        for month, group in test.groupby(test["timestamp"].dt.month)
    ]
    seasons = test["timestamp"].dt.month.map(SEASONS)
    seasonal = [{"season": season, **pair(test[seasons == season])} for season in ["zima", "wiosna", "lato", "jesien"] if (seasons == season).any()]
    return {
        "test_period": {"from": test["timestamp"].min().isoformat(), "to": test["timestamp"].max().isoformat(), "points": len(test)},
        "hourly": pair(test),
        "daily": pair(daily.reset_index()),
        "monthly": monthly,
        "seasonal": seasonal,
        "methodology": (
            "Blokowany holdout: koncowe 20% kazdego miesiaca. Baseline = model fizyczny (POA z Open-Meteo, moc, straty, "
            "temperatura ogniw) skalibrowany na danych treningowych; XGBoost uczy sie korekty tego modelu. "
            "MAPE pomija godziny z produkcja <= 0.05 kWh."
        ),
    }


# ---------------------------------------------------------------------------
# Anomalie
# ---------------------------------------------------------------------------


ANOMALY_THRESHOLD_PCT = -30.0
MIN_DAY_COVERAGE = 0.8  # wymagany odsetek godzin dziennych z odczytem produkcji
MIN_DAY_EXPECTED_KWH_PER_KWP = 0.3  # pomijamy bardzo ciemne dni -- za duzy szum


def daily_expected_vs_actual(rows: list[dict[str, Any]], bundle: dict[str, Any], spec: InstallationSpec) -> list[dict[str, Any]]:
    """
    rows: godziny pogody historycznej (z energy_kwh = None, gdy brak odczytu).
    Dla kazdego lokalnego dnia liczy produkcje oczekiwana przy RZECZYWISTEJ
    pogodzie i porownuje z produkcja. Dni po zakonczeniu danych treningowych
    licza sie wybranym modelem; dni z okresu treningowego -- skalibrowanym
    modelem fizycznym (1 parametr, wiec bez wycieku danych z treningu).
    """
    df = build_features(rows, spec)
    if df.empty:
        return []
    df["energy_kwh"] = pd.to_numeric(df.get("energy_kwh"), errors="coerce")
    trained_until = pd.Timestamp(bundle["trained_until"])
    after_training = df["timestamp"] > trained_until
    expected = _predict_frame(df, bundle, spec, predictor="baseline")
    if after_training.any():
        expected[after_training.to_numpy()] = _predict_frame(df[after_training], bundle, spec)
    df["predicted"] = expected
    df["method"] = np.where(after_training, bundle["predictor"], "baseline")
    df["daylight"] = _daylight_mask(df, spec)

    local = df["timestamp"].dt.tz_localize("UTC").dt.tz_convert(LOCAL_TIMEZONE)
    df["local_day"] = local.dt.normalize()

    results = []
    for day, group in df.groupby("local_day"):
        daylight = group[group["daylight"]]
        if daylight.empty:
            continue
        with_reading = daylight[daylight["energy_kwh"].notna()]
        coverage = len(with_reading) / len(daylight)
        predicted = float(with_reading["predicted"].sum())
        actual = float(with_reading["energy_kwh"].sum())
        if coverage < MIN_DAY_COVERAGE:
            continue  # brak odczytow to nie to samo co brak produkcji
        dark_day = predicted < MIN_DAY_EXPECTED_KWH_PER_KWP * spec.peak_power_kwp
        # w bardzo ciemne dni wzgledne odchylenie to glownie szum -- ale zerowa
        # produkcja przy jakimkolwiek swietle nadal jest jednoznaczna
        if dark_day and not (actual < 0.05 * predicted and predicted >= 0.05 * spec.peak_power_kwp):
            continue
        results.append(
            {
                "period_start": day.tz_convert("UTC").tz_localize(None).to_pydatetime(),
                "period_end": (day + pd.DateOffset(days=1)).tz_convert("UTC").tz_localize(None).to_pydatetime(),
                "predicted_kwh": predicted,
                "actual_kwh": actual,
                "coverage": round(coverage, 2),
                "avg_cloud_cover": float(daylight["cloud_cover"].mean()),
                "avg_temperature": float(daylight["temperature"].mean()),
                "method": str(group["method"].iloc[-1]),
            }
        )
    return results


def compute_deviation_pct(predicted_kwh: float, actual_kwh: float) -> float | None:
    """Odchylenie rzeczywistej produkcji od prognozy, w procentach (-38 = 38% ponizej)."""
    if predicted_kwh is None or predicted_kwh <= 0:
        return None
    return round(((actual_kwh - predicted_kwh) / predicted_kwh) * 100, 1)


def detect_anomaly(
    predicted_kwh: float,
    actual_kwh: float,
    threshold_pct: float = ANOMALY_THRESHOLD_PCT,
) -> dict[str, Any] | None:
    """Prosta detekcja anomalii przez porownanie pojedynczego punktu prognoza/rzeczywistosc."""
    deviation_pct = compute_deviation_pct(predicted_kwh, actual_kwh)
    if deviation_pct is not None and deviation_pct <= threshold_pct:
        return {"deviation_pct": deviation_pct}
    return None


def classify_cause(
    deviation_pct: float,
    avg_cloud_cover: float | None,
    avg_temperature: float | None,
    recent_deviations: list[float],
) -> str | None:
    """
    Klasyfikuje prawdopodobna przyczyne anomalii na podstawie prostych regul.

    recent_deviations: odchylenia (%) z poprzednich dni tej instalacji, w
    kolejnosci chronologicznej, bez biezacego dnia -- sluza do wykrycia trendu
    (stopniowe pogarszanie sie = zabrudzenie, utrzymujacy sie ale stabilny
    spadek = spadek sprawnosci).
    """
    if avg_temperature is not None and avg_temperature <= 1.0 and deviation_pct <= -40:
        return "śnieg"

    if deviation_pct <= -85:
        return "awaria-falownika"

    if avg_cloud_cover is not None and avg_cloud_cover < 20 and deviation_pct <= -35:
        return "cień"

    considered = [d for d in recent_deviations[-3:] if d <= -15]
    if len(considered) >= 2:
        if considered[-1] <= considered[0] - 5:
            return "zabrudzenie"
        return "spadek-sprawnosci"

    return None
