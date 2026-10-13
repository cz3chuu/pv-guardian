-- CreateTable
CREATE TABLE "installations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "peakPowerKwp" DOUBLE PRECISION NOT NULL,
    "tiltAngle" DOUBLE PRECISION NOT NULL,
    "azimuth" DOUBLE PRECISION NOT NULL,
    "losses" DOUBLE PRECISION NOT NULL DEFAULT 14,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weather_readings" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "shortwaveRadiation" DOUBLE PRECISION,
    "cloudCover" DOUBLE PRECISION,
    "temperature" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weather_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_readings" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "energyKwh" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'csv-upload',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecasts" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "predictedKwh" DOUBLE PRECISION NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomalies" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "deviationPct" DOUBLE PRECISION NOT NULL,
    "suspectedCause" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weather_readings_installationId_timestamp_idx" ON "weather_readings"("installationId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "weather_readings_installationId_timestamp_source_key" ON "weather_readings"("installationId", "timestamp", "source");

-- CreateIndex
CREATE INDEX "production_readings_installationId_timestamp_idx" ON "production_readings"("installationId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "production_readings_installationId_timestamp_key" ON "production_readings"("installationId", "timestamp");

-- CreateIndex
CREATE INDEX "forecasts_installationId_timestamp_idx" ON "forecasts"("installationId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "forecasts_installationId_timestamp_modelVersion_key" ON "forecasts"("installationId", "timestamp", "modelVersion");

-- CreateIndex
CREATE INDEX "anomalies_installationId_periodStart_idx" ON "anomalies"("installationId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "anomalies_installationId_periodStart_periodEnd_key" ON "anomalies"("installationId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "weather_readings" ADD CONSTRAINT "weather_readings_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_readings" ADD CONSTRAINT "production_readings_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
