import Link from "next/link";
import type { ReactNode } from "react";
import "./styles.css";
import "./operations.css";
import "./manual.css";
import "./simulation/simulation.css";
import "./designer/roof-3d.css";
import "./designer/map-3d.css";
import "./simulation/simulation-bridge.css";
import "./designer/surface-geometry.css";
import "./designer/project-workflow.css";
import "./designer/guided-mode.css";
import "./offline.css";
import "./regional-live/regional-live.css";
import "./regional-live/regional-extras.css";
import "./designer/designer.css";
import "./designer/address-drawing.css";
import "./designer/basemap-switch.css";
import "./designer/smart-features.css";
import "./designer/advanced-design.css";
import "./designer/live-prices.css";
import "./designer/professional-report.css";
import "./designer/panel-layout.css";
import "./designer/edge-measurements.css";
import "./designer/precision-editor.css";
import "./designer/panel-manual-editor.css";
import "./designer/roof-obstacle-editor.css";
import "./designer/smart-layout-generator.css";
import "./designer/device-catalog.css";
import "./designer/string-designer.css";
import "./analysis.css";
import "./location.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./visuals.css";
import "./midnight-solar.css";
import "./brand-logo.css";
import "./midnight-solar-2.css";

export const metadata = { title: "PV Guardian", description: "Prognozowanie produkcji PV i wykrywanie anomalii" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="pl"><body><header className="topbar"><Link className="brand" href="/"><span className="brand-logo-crop"><img src="/brand/pv-guardian-logo.png" alt=""/></span><span className="brand-copy"><strong>PV Guardian</strong><small>Solar Intelligence</small></span></Link><nav><Link href="/">Dashboard</Link><Link href="/regional-live">Mapa PV Live</Link><Link href="/designer">Projektant PV</Link><Link href="/simulation">Symulacja</Link><Link href="/installations">Instalacje</Link></nav></header>{children}</body></html>;
}
