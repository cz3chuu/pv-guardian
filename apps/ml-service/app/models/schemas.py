from datetime import datetime

from pydantic import BaseModel, Field


class InstallationIn(BaseModel):
    name: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    peak_power_kwp: float = Field(gt=0)
    tilt_angle: float = Field(ge=0, le=90)
    azimuth: float = Field(ge=-180, le=180, description="0 = poludnie, zgodnie z konwencja PVGIS")
    losses: float = Field(default=14, ge=0, le=100)


class WeatherPoint(BaseModel):
    timestamp: datetime
    source: str
    shortwave_radiation: float | None = None
    cloud_cover: float | None = None
    temperature: float | None = None
    predicted_power_kw: float | None = None


class ForecastRequest(BaseModel):
    installation_id: str
    latitude: float
    longitude: float
    peak_power_kwp: float
    tilt_angle: float
    azimuth: float
    losses: float = 14


class SimulationRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    peak_power_kwp: float = Field(gt=0, le=1000)
    tilt_angle: float = Field(default=30, ge=0, le=90)
    azimuth: float = Field(default=0, ge=-180, le=180)
    losses: float = Field(default=14, ge=0, lt=100)
    annual_consumption_kwh: float | None = Field(default=None, gt=0)
    start_year: int = Field(default=2019, ge=2005, le=2023)
    end_year: int = Field(default=2023, ge=2005, le=2023)


class InstallationOut(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    peak_power_kwp: float
    tilt_angle: float
    azimuth: float
    losses: float

    class Config:
        from_attributes = True


class IngestResult(BaseModel):
    installation_id: str
    source: str
    points_fetched: int
    points_persisted: int


class AnomalyOut(BaseModel):
    id: str
    period_start: datetime
    period_end: datetime
    deviation_pct: float
    suspected_cause: str | None
    status: str

    class Config:
        from_attributes = True
