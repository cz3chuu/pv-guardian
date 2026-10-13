type Point = { timestamp: Date; actual: number | null; predicted: number | null };
export function ProductionChart({ points }: { points: Point[] }) {
  if (!points.length) return <div className="chart-empty">Brak danych produkcji lub prognozy do wyświetlenia.</div>;
  const width = 900, height = 280, pad = 36;
  const max = Math.max(1, ...points.flatMap((p) => [p.actual ?? 0, p.predicted ?? 0]));
  const x = (i: number) => pad + i * (width - pad * 2) / Math.max(1, points.length - 1);
  const y = (v: number) => height - pad - v / max * (height - pad * 2);
  const path = (key: "actual" | "predicted") => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key] ?? 0).toFixed(1)}`).join(" ");
  return <div className="chart-wrap"><div className="legend"><span><i className="actual"/>Produkcja</span><span><i className="predicted"/>Prognoza</span></div><svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Wykres produkcji i prognozy">{[0,.25,.5,.75,1].map((level)=><line key={level} x1={pad} x2={width-pad} y1={y(max*level)} y2={y(max*level)} className="grid-line"/>)}<path d={path("predicted")} className="line predicted-line"/><path d={path("actual")} className="line actual-line"/></svg></div>;
}
