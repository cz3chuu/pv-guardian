import { prisma } from "@pv-guardian/db";
import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_CSV_TIMEZONE, isValidTimeZone, parseProductionCsv } from "@/lib/csv";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const installationId = (await params).id;

  const installation = await prisma.installation.findUnique({ where: { id: installationId } });
  if (!installation) {
    return NextResponse.json({ error: "Instalacja nie znaleziona" }, { status: 404 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Brak pliku CSV (pole 'file')" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Plik jest za duży (maksymalnie 20 MB)" }, { status: 413 });
  }

  const timeZone = String(formData.get("timezone") ?? DEFAULT_CSV_TIMEZONE);
  if (!isValidTimeZone(timeZone)) {
    return NextResponse.json({ error: `Nieznana strefa czasowa "${timeZone}"` }, { status: 400 });
  }
  const replace = formData.get("replace") === "true";

  const text = await file.text();
  const { rows, errors, aggregatedFrom } = parseProductionCsv(text, timeZone);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Brak poprawnych wierszy w CSV", parseErrors: errors }, { status: 400 });
  }

  const data = rows.map((r) => ({
    installationId,
    timestamp: r.timestamp,
    energyKwh: r.energyKwh,
    source: "csv-upload",
  }));

  // Bez "replace": createMany + skipDuplicates (unikalny klucz installationId+timestamp)
  // -- ponowny upload nie tworzy duplikatow i nie zmienia istniejacych wartosci.
  // Z "replace": najpierw usuwamy odczyty z zakresu pliku, np. zeby poprawic
  // dane wgrane wczesniej z bledna strefa czasowa.
  const [deleted, result] = await prisma.$transaction(async (tx) => {
    const removed = replace
      ? await tx.productionReading.deleteMany({
          where: { installationId, timestamp: { gte: rows[0].timestamp, lte: rows[rows.length - 1].timestamp } },
        })
      : { count: 0 };
    const created = await tx.productionReading.createMany({ data, skipDuplicates: true });
    return [removed.count, created] as const;
  });

  return NextResponse.json({
    totalRows: rows.length,
    inserted: result.count,
    skipped: rows.length - result.count,
    replaced: deleted,
    aggregatedFrom,
    timeZone,
    range: { from: rows[0].timestamp, to: rows[rows.length - 1].timestamp },
    parseErrors: errors,
  });
}
