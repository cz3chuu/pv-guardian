import { prisma } from "@pv-guardian/db";
import { NextRequest, NextResponse } from "next/server";
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: installationId } = await params;
  const installation = await prisma.installation.findUnique({ where: { id: installationId }, select: { id: true } });
  if (!installation) return NextResponse.json({ error: "Instalacja nie została znaleziona" }, { status: 404 });
  const body = await request.json().catch(() => null); const timestamp = new Date(body?.timestamp); const energyKwh = Number(body?.energyKwh);
  if (Number.isNaN(timestamp.getTime())) return NextResponse.json({ error: "Podaj poprawną datę i godzinę" }, { status: 400 });
  if (!Number.isFinite(energyKwh) || energyKwh < 0) return NextResponse.json({ error: "Produkcja musi być liczbą nie mniejszą niż 0" }, { status: 400 });
  const reading = await prisma.productionReading.upsert({ where: { installationId_timestamp: { installationId, timestamp } }, create: { installationId, timestamp, energyKwh, source: "manual-entry" }, update: { energyKwh, source: "manual-entry" }, select: { id: true, timestamp: true, energyKwh: true } });
  return NextResponse.json({ reading, message: "Odczyt został zapisany" });
}
