"use client";

import {useMemo,useState} from "react";
import type {SolarPanel} from "./panel-layout";
import type {RoofPoint} from "./roof-map";
import type {RoofSurface} from "./advanced-design";
import type {ShadowObstacle} from "./shadow-analysis";

type Props={surfaces:RoofSurface[];panels:SolarPanel[];obstacles:ShadowObstacle[];tilt:number;invalidPanelIds?:string[]};
type XY={x:number;y:number};
type Screen={x:number;y:number};

export function Roof3dPreview({surfaces,panels,obstacles,invalidPanelIds=[]}:Props){
  const [yaw,setYaw]=useState(-28),[elevation,setElevation]=useState(48),[exaggeration,setExaggeration]=useState(1.5);
  const invalid=new Set(invalidPanelIds);
  const scene=useMemo(()=>{
    const geo:RoofPoint[]=[...surfaces.flatMap(surface=>surface.points),...panels.flatMap(panel=>panel.corners)];
    if(!geo.length)return null;
    const origin=geo[0],mx=111320*Math.cos(origin[1]*Math.PI/180),my=110540;
    const local=([lng,lat]:RoofPoint):XY=>({x:(lng-origin[0])*mx,y:(lat-origin[1])*my});
    const localPoints=geo.map(local),minX=Math.min(...localPoints.map(p=>p.x)),maxX=Math.max(...localPoints.map(p=>p.x)),minY=Math.min(...localPoints.map(p=>p.y)),maxY=Math.max(...localPoints.map(p=>p.y));
    const centerX=(minX+maxX)/2,centerY=(minY+maxY)/2,scale=370/Math.max(maxX-minX,maxY-minY,1),turn=yaw*Math.PI/180,pitch=elevation*Math.PI/180;
    const project=(point:RoofPoint,heightM=0):Screen=>{const value=local(point),x=value.x-centerX,y=value.y-centerY,rx=x*Math.cos(turn)-y*Math.sin(turn),ry=x*Math.sin(turn)+y*Math.cos(turn);return{x:260+rx*scale,y:205+ry*scale*Math.sin(pitch)-heightM*scale*.72*exaggeration}};
    const path=(points:Screen[])=>points.map((point,index)=>`${index?"L":"M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ")+" Z";
    const heightAt=(point:RoofPoint,surface:RoofSurface)=>{const azimuth=surface.azimuth*Math.PI/180,axis=(item:RoofPoint)=>{const p=local(item);return p.x*-Math.sin(azimuth)+p.y*Math.cos(azimuth)},lowest=Math.min(...surface.points.map(axis));return Math.max(0,(axis(point)-lowest)*Math.tan(Math.max(0,Math.min(70,surface.tilt))*Math.PI/180))};
    const roof=surfaces.map(surface=>{const top=surface.points.map(point=>project(point,heightAt(point,surface))),base=surface.points.map(point=>project(point,0));const sides=surface.points.map((_,index)=>path([base[index],base[(index+1)%base.length],top[(index+1)%top.length],top[index]]));return{surface,top:path(top),sides}});
    const modules=panels.map(panel=>{const surface=surfaces.find(item=>item.id===panel.surfaceId);return{panel,path:path(panel.corners.map(point=>project(point,surface?heightAt(point,surface)+.09:.09)))}});
    const markers=obstacles.map(item=>{const point:[number,number]=[item.longitude,item.latitude],surface=surfaces.find(candidate=>candidate.points.length>2),base=surface?heightAt(point,surface):0;return{item,top:project(point,base+item.height),bottom:project(point,base)}});
    return{roof,modules,markers};
  },[surfaces,panels,obstacles,yaw,elevation,exaggeration]);

  return <section className="roof-3d" aria-label="Interaktywny model dachu 3D">
    <div className="roof-3d-head"><div><span>Geometria połaci</span><strong>Model dachu 3D</strong></div><div className="roof-3d-stats"><b>{panels.length}</b> modułów · <b>{surfaces.length}</b> połaci</div></div>
    <div className="roof-3d-canvas">
      {!scene?<div className="roof-3d-empty"><span>◇</span><strong>Narysuj i zapisz połać</strong><small>Model przestrzenny pojawi się automatycznie.</small></div>:<svg viewBox="0 0 520 390" role="img" aria-label={`Przestrzenny dach z ${panels.length} modułami`}>
        <defs><linearGradient id="roof3d" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#38594f"/><stop offset="1" stopColor="#172b25"/></linearGradient><linearGradient id="panel3d" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#278fe8"/><stop offset="1" stopColor="#093a69"/></linearGradient><filter id="shadow3d"><feDropShadow dx="0" dy="12" stdDeviation="10" floodOpacity=".45"/></filter></defs>
        <ellipse cx="260" cy="335" rx="210" ry="35" fill="#020807" opacity=".45"/>
        <g filter="url(#shadow3d)">{scene.roof.flatMap(({surface,sides})=>sides.map((side,index)=><path key={`${surface.id}-side-${index}`} d={side} fill="#10211c" stroke="#4d7165" strokeWidth="1"/>))}{scene.roof.map(({surface,top})=><path key={surface.id} d={top} fill="url(#roof3d)" stroke="#91b5a8" strokeWidth="2"><title>{surface.name}: {surface.tilt}°</title></path>)}</g>
        {scene.modules.map(({panel,path})=><path key={panel.id} d={path} fill={invalid.has(panel.id)?"#b83f55":"url(#panel3d)"} stroke={invalid.has(panel.id)?"#ff91a2":"#b5e1ff"} strokeWidth="1.15"/>)}
        {scene.markers.map(({item,top,bottom})=><g key={item.id}><line x1={bottom.x} y1={bottom.y} x2={top.x} y2={top.y} stroke="#ffbf69" strokeWidth="5"/><circle cx={top.x} cy={top.y} r="6" fill="#ffbf69"/><title>{item.label}</title></g>)}
        <g className="roof-3d-compass"><circle cx="458" cy="52" r="24"/><path d="M458 26l7 25-7-4-7 4z"/><text x="458" y="19">N</text></g>
      </svg>}
      {scene&&<div className="roof-3d-badge"><i/> Geometria z parametrów połaci</div>}
    </div>
    <div className="roof-3d-controls"><label>Obrót <input type="range" min="-180" max="180" value={yaw} onChange={event=>setYaw(+event.target.value)}/></label><label>Perspektywa <input type="range" min="24" max="75" value={elevation} onChange={event=>setElevation(+event.target.value)}/></label><label>Wysokość ×{exaggeration.toFixed(1)}<input type="range" min=".6" max="3" step=".1" value={exaggeration} onChange={event=>setExaggeration(+event.target.value)}/></label><button type="button" onClick={()=>{setYaw(-28);setElevation(48);setExaggeration(1.5)}}>Resetuj</button></div>
  </section>;
}
