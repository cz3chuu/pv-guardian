import Link from "next/link";
import { prisma } from "@pv-guardian/db";
import { InstallationForm } from "./installation-form";

export const dynamic = "force-dynamic";
export default async function InstallationsPage() {
  const installations = await prisma.installation.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { anomalies: true, productionReadings: true, forecasts: true } } } });
  return <main className="shell"><div className="page-head"><div><p className="eyebrow">Portfolio</p><h1>Instalacje</h1><p className="lead">Wybierz instalację, aby zobaczyć produkcję, prognozy i alerty.</p></div></div><section className="panel create-panel"><div className="panel-head"><div><p className="eyebrow">Nowa instalacja</p><h2>Dodaj system PV</h2></div></div><InstallationForm /></section><section className="cards">
    {installations.map((item) => <Link className="site-card" href={`/installations/${item.id}`} key={item.id}><div className="site-card-top"><span className="solar-icon">☀</span><span className="badge">aktywna</span></div><h2>{item.name}</h2><p>{item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}</p><dl><div><dt>Moc</dt><dd>{item.peakPowerKwp} kWp</dd></div><div><dt>Odczyty</dt><dd>{item._count.productionReadings}</dd></div><div><dt>Alerty</dt><dd>{item._count.anomalies}</dd></div></dl></Link>)}
    {!installations.length && <div className="panel empty">Nie ma jeszcze żadnych instalacji.</div>}
  </section></main>;
}
