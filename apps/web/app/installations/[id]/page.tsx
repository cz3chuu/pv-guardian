import { prisma } from "@pv-guardian/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductionChart } from "../../production-chart";
import { ManualProductionForm } from "./manual-production-form";
import { ModelAnalysis } from "./model-analysis";
import { OperationsPanel } from "./operations-panel";
import { UploadProductionForm } from "./upload-form";

export const dynamic = "force-dynamic";
const fmt = new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "short", year: "numeric" });

export default async function InstallationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const installation = await prisma.installation.findUnique({ where: { id } });
  if (!installation) notFound();
  const [production, forecasts, anomalies] = await Promise.all([
    prisma.productionReading.findMany({ where: { installationId: id }, orderBy: { timestamp: "desc" }, take: 336 }),
    prisma.forecast.findMany({ where: { installationId: id }, orderBy: { timestamp: "desc" }, take: 336 }),
    prisma.anomaly.findMany({ where: { installationId: id }, orderBy: { periodStart: "desc" }, take: 20 }),
  ]);
  const byTime = new Map<string, { timestamp: Date; actual: number | null; predicted: number | null }>();
  for (const row of production) byTime.set(row.timestamp.toISOString(), { timestamp: row.timestamp, actual: row.energyKwh, predicted: null });
  for (const row of forecasts) { const key = row.timestamp.toISOString(); const point = byTime.get(key); byTime.set(key, point ? { ...point, predicted: row.predictedKwh } : { timestamp: row.timestamp, actual: null, predicted: row.predictedKwh }); }
  const chartPoints = [...byTime.values()].sort((a,b) => a.timestamp.getTime()-b.timestamp.getTime());
  const openAlerts = anomalies.filter((a) => a.status === "open").length;

  return <main className="shell">
    <Link className="back" href="/installations">← Wszystkie instalacje</Link>
    <div className="page-head"><div><p className="eyebrow">Instalacja</p><h1>{installation.name}</h1><p className="lead">{installation.peakPowerKwp} kWp · {installation.latitude}, {installation.longitude}</p></div><span className="badge">monitorowana</span></div>
    <section className="metrics compact"><article className="metric"><span>Odczyty</span><strong>{production.length}</strong><small>ostatnio pobrane punkty</small></article><article className="metric"><span>Prognozy</span><strong>{forecasts.length}</strong><small>ostatnio pobrane punkty</small></article><article className="metric"><span>Otwarte alerty</span><strong className={openAlerts ? "danger" : "success"}>{openAlerts}</strong><small>z {anomalies.length} wykrytych</small></article></section>
    <OperationsPanel installationId={id}/>
    <section className="panel chart-panel"><div className="panel-head"><div><p className="eyebrow">Ostatnie dane</p><h2>Produkcja i prognoza</h2></div><span>kWh</span></div><ProductionChart points={chartPoints}/></section>
    <ModelAnalysis installationId={id}/>
    <div className="detail-grid">
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">Diagnostyka</p><h2>Alerty</h2></div></div><div className="alert-list">{anomalies.map((a)=><div className="alert-row" key={a.id}><span className={`alert-icon ${a.status}`}>!</span><span className="grow"><strong>{a.suspectedCause?.replaceAll("-", " ") ?? "do weryfikacji"}</strong><small>{fmt.format(a.periodStart)} · {a.status}</small></span><strong className="danger">{a.deviationPct.toFixed(1)}%</strong></div>)}{!anomalies.length&&<div className="empty success">Brak wykrytych anomalii.</div>}</div></section>
      <section className="panel manual-panel"><div className="panel-head"><div><p className="eyebrow">Pojedynczy odczyt</p><h2>Wpisz produkcję ręcznie</h2></div></div><ManualProductionForm installationId={id}/></section>
      <section className="panel upload-panel"><div className="panel-head"><div><p className="eyebrow">Wiele odczytów</p><h2>Import CSV</h2></div></div><p>Plik z nagłówkiem <code>timestamp,energy_kwh</code> (separator <code>,</code> lub <code>;</code>). Znacznik czasu oznacza <strong>początek</strong> okresu; dane 5/15-minutowe są sumowane do pełnych godzin.</p><UploadProductionForm installationId={id}/></section>
    </div>
  </main>;
}
