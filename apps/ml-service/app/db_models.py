"""
Modele SQLAlchemy dla tabel tworzonych przez Prisma (packages/db/prisma/schema.prisma).

Prisma domyslnie zachowuje camelCase nazwy kolumn w Postgresie (nie ma tu
@map na polach, tylko @@map na nazwach tabel), wiec kolumny trzeba
zadeklarowac z dokladnie takimi samymi, cudzyslowionymi nazwami.

ml-service NIE zarzadza migracjami -- to robi Prisma
(`npm run db:migrate` w root package.json). Te modele sa tylko do
odczytu/zapisu na juz istniejacym schemacie.
"""

from sqlalchemy import Column, DateTime, Float, ForeignKey, String, Text
from sqlalchemy.orm import relationship

from app.db import Base


class Installation(Base):
    __tablename__ = "installations"

    id = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    peakPowerKwp = Column("peakPowerKwp", Float, nullable=False)
    tiltAngle = Column("tiltAngle", Float, nullable=False)
    azimuth = Column(Float, nullable=False)
    losses = Column(Float, nullable=False, default=14)
    createdAt = Column("createdAt", DateTime, nullable=False)
    updatedAt = Column("updatedAt", DateTime, nullable=False)

    weather_readings = relationship("WeatherReading", back_populates="installation")


class WeatherReading(Base):
    __tablename__ = "weather_readings"

    id = Column(Text, primary_key=True)
    installationId = Column("installationId", Text, ForeignKey("installations.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime, nullable=False)
    source = Column(String, nullable=False)  # "open-meteo" | "open-meteo-history" | "pvgis"
    shortwaveRadiation = Column("shortwaveRadiation", Float, nullable=True)
    tiltedRadiation = Column("tiltedRadiation", Float, nullable=True)
    cloudCover = Column("cloudCover", Float, nullable=True)
    temperature = Column(Float, nullable=True)
    createdAt = Column("createdAt", DateTime, nullable=False)

    installation = relationship("Installation", back_populates="weather_readings")


class Forecast(Base):
    __tablename__ = "forecasts"

    id = Column(Text, primary_key=True)
    installationId = Column("installationId", Text, ForeignKey("installations.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime, nullable=False)
    predictedKwh = Column("predictedKwh", Float, nullable=False)
    modelVersion = Column("modelVersion", String, nullable=False)
    createdAt = Column("createdAt", DateTime, nullable=False)


class ProductionReading(Base):
    __tablename__ = "production_readings"

    id = Column(Text, primary_key=True)
    installationId = Column("installationId", Text, ForeignKey("installations.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime, nullable=False)
    energyKwh = Column("energyKwh", Float, nullable=False)
    source = Column(String, nullable=False, default="csv-upload")
    createdAt = Column("createdAt", DateTime, nullable=False)


class Anomaly(Base):
    __tablename__ = "anomalies"

    id = Column(Text, primary_key=True)
    installationId = Column("installationId", Text, ForeignKey("installations.id", ondelete="CASCADE"), nullable=False)
    periodStart = Column("periodStart", DateTime, nullable=False)
    periodEnd = Column("periodEnd", DateTime, nullable=False)
    deviationPct = Column("deviationPct", Float, nullable=False)
    suspectedCause = Column("suspectedCause", String, nullable=True)
    status = Column(String, nullable=False, default="open")
    createdAt = Column("createdAt", DateTime, nullable=False)
