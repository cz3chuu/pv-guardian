"use client";
import type {RoofSurface} from "./advanced-design";

export function SurfaceGeometryEditor({surfaces,onChange}:{surfaces:RoofSurface[];onChange:(items:RoofSurface[])=>void}){
  if(!surfaces.length)return null;
  const update=(id:string,patch:Partial<RoofSurface>)=>onChange(surfaces.map(item=>item.id===id?{...item,...patch}:item));
  return <section className="surface-geometry panel no-print"><div className="panel-head"><div><p className="eyebrow">Geometria 3D</p><h2>Nachylenie poszczególnych połaci</h2></div><span>{surfaces.length} powierzchni</span></div><p className="surface-geometry-note">Każda połać jest osobną płaszczyzną. Ustaw kierunek spadku i kąt zgodnie z rzeczywistym dachem.</p><div className="surface-geometry-list">{surfaces.map((surface,index)=><article key={surface.id}><b>{index+1}</b><strong>{surface.name}</strong><label>Kierunek<select value={surface.azimuth} onChange={event=>update(surface.id,{azimuth:+event.target.value})}><option value="-180">Północ</option><option value="-90">Wschód</option><option value="0">Południe</option><option value="90">Zachód</option><option value="180">Północ</option></select></label><label>Nachylenie<div><input type="range" min="0" max="70" value={surface.tilt} onChange={event=>update(surface.id,{tilt:+event.target.value})}/><output>{surface.tilt}°</output></div></label></article>)}</div></section>;
}
