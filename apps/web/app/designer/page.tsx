"use client";

import dynamic from "next/dynamic";

const PvDesigner = dynamic(
  () => import("./pv-designer").then((module) => module.PvDesigner),
  { ssr: false, loading: () => <div className="panel empty">Ładowanie projektanta…</div> },
);

export default function DesignerPage(){return <main className="shell designer-shell"><div className="page-head no-print"><div><p className="eyebrow">Projektant instalacji</p><h1>Cyfrowy bliźniak domu</h1><p className="lead">Zmierz dach, dobierz instalację i sprawdź finanse — od pierwszego panelu do 25 lat pracy.</p></div></div><PvDesigner/></main>}
