"use client";
import {useEffect,useRef,useState} from "react";
import type {GeoJSONSource,Map as MapLibreMap,Marker as MapLibreMarker} from "maplibre-gl";
import type {ShadowObstacle} from "./shadow-analysis";
import type {SolarPanel} from "./panel-layout";
import {mapDistanceMeters} from "./panel-layout";
import {obstaclePolygon} from "./panel-validation";

export type RoofPoint=[number,number];
export type RoofSurfaceMap={id:string;name:string;points:RoofPoint[]};

export function polygonArea(points:RoofPoint[]){
  if(points.length<3)return 0;
  const lat=points.reduce((sum,point)=>sum+point[1],0)/points.length*Math.PI/180;
  const mx=111320*Math.cos(lat),my=110540;
  let sum=0;
  for(let index=0;index<points.length;index++){
    const current=points[index],next=points[(index+1)%points.length];
    sum+=(current[0]*mx)*(next[1]*my)-(next[0]*mx)*(current[1]*my);
  }
  return Math.abs(sum)/2;
}

type Props={
  center:RoofPoint;
  points:RoofPoint[];
  surfaces?:RoofSurfaceMap[];
  drawingEnabled?:boolean;
  editTool?:"draw"|"delete";
  mode?:"roof"|"obstacle";
  obstacles?:ShadowObstacle[];
  panels?:SolarPanel[];
  selectedPanelIds?:string[];
  measurementEnabled?:boolean;
  measurementPoints?:RoofPoint[];
  calibrationFactor?:number;
  gridEnabled?:boolean;
  gridStepM?:number;
  snapEnabled?:boolean;
  orthogonalSnap?:boolean;
  panelIssues?:Record<string,string[]>;
  onChange:(points:RoofPoint[])=>void;
  onDrawingComplete?:()=>void;
  onObstacleAdd?:(point:RoofPoint)=>void;
  onSnapshot?:(value:string)=>void;
  onPanelSelect?:(id:string|null,additive:boolean)=>void;
  onPanelDrag?:(id:string,eastM:number,northM:number)=>void;
  onMeasurementPoint?:(point:RoofPoint)=>void;
};

export function RoofMap({center,points,surfaces=[],drawingEnabled=false,editTool="draw",mode="roof",obstacles=[],panels=[],selectedPanelIds=[],measurementEnabled=false,measurementPoints=[],calibrationFactor=1,gridEnabled=false,gridStepM=.25,snapEnabled=false,orthogonalSnap=false,panelIssues={},onChange,onDrawingComplete=()=>{},onObstacleAdd=()=>{},onSnapshot=()=>{},onPanelSelect=()=>{},onPanelDrag=()=>{},onMeasurementPoint=()=>{}}:Props){
  const node=useRef<HTMLDivElement>(null),map=useRef<MapLibreMap|null>(null),centerMarker=useRef<MapLibreMarker|null>(null),vertexMarkers=useRef<MapLibreMarker[]>([]),edgeMarkers=useRef<MapLibreMarker[]>([]);
  const [ready,setReady]=useState(false),[basemap,setBasemap]=useState<"map"|"satellite"|"hybrid">("satellite"),[viewMode,setViewMode]=useState<"2d"|"3d">("2d");
  const pointsRef=useRef(points),drawingRef=useRef(drawingEnabled),toolRef=useRef(editTool),modeRef=useRef(mode),changeRef=useRef(onChange),completeRef=useRef(onDrawingComplete),obstacleRef=useRef(onObstacleAdd),snapshotRef=useRef(onSnapshot),panelSelectRef=useRef(onPanelSelect),panelDragRef=useRef(onPanelDrag),measurementEnabledRef=useRef(measurementEnabled),measurementPointRef=useRef(onMeasurementPoint),snapRef=useRef(snapEnabled),orthogonalRef=useRef(orthogonalSnap),gridStepRef=useRef(gridStepM),calibrationRef=useRef(calibrationFactor),centerRef=useRef(center);
  pointsRef.current=points;drawingRef.current=drawingEnabled;toolRef.current=editTool;modeRef.current=mode;changeRef.current=onChange;completeRef.current=onDrawingComplete;obstacleRef.current=onObstacleAdd;snapshotRef.current=onSnapshot;panelSelectRef.current=onPanelSelect;panelDragRef.current=onPanelDrag;measurementEnabledRef.current=measurementEnabled;measurementPointRef.current=onMeasurementPoint;snapRef.current=snapEnabled;orthogonalRef.current=orthogonalSnap;gridStepRef.current=gridStepM;calibrationRef.current=calibrationFactor;centerRef.current=center;

  useEffect(()=>{
    if(!node.current||map.current)return;
    let disposed=false;
    void import("maplibre-gl").then(({Map,NavigationControl})=>{
      if(disposed||!node.current)return;
      const instance=new Map({container:node.current,center,zoom:18,maxZoom:20,canvasContextAttributes:{preserveDrawingBuffer:true},style:{version:8,sources:{satellite:{type:"raster",tiles:[process.env.NEXT_PUBLIC_SATELLITE_TILES_URL??"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],tileSize:256,maxzoom:20,attribution:"Esri, Maxar, Earthstar Geographics, GIS User Community"},osm:{type:"raster",tiles:[process.env.NEXT_PUBLIC_MAP_TILES_URL??"https://tile.openstreetmap.org/{z}/{x}/{y}.png"],tileSize:256,maxzoom:20,attribution:"© OpenStreetMap contributors"}},layers:[{id:"satellite",type:"raster",source:"satellite"},{id:"osm",type:"raster",source:"osm",layout:{visibility:"none"}}]}});
      instance.addControl(new NavigationControl(),"top-right");
      instance.on("click",event=>{
        if(measurementEnabledRef.current){measurementPointRef.current([event.lngLat.lng,event.lngLat.lat]);return}
        if(!drawingRef.current){const hit=instance.getLayer("roof-panels")?instance.queryRenderedFeatures(event.point,{layers:["roof-panels"]})[0]:undefined,original=event.originalEvent as MouseEvent;panelSelectRef.current(typeof hit?.properties?.id==="string"?hit.properties.id:null,original.ctrlKey||original.metaKey||original.shiftKey);return}
        if(toolRef.current!=="draw")return;
        let point:RoofPoint=[event.lngLat.lng,event.lngLat.lat];
        if(modeRef.current==="obstacle"){obstacleRef.current(point);return;}
        if(snapRef.current&&gridStepRef.current>0){
          const origin=pointsRef.current[0]??centerRef.current,factor=Math.max(.1,calibrationRef.current),mx=111320*Math.cos(origin[1]*Math.PI/180)*factor,my=110540*factor;
          point=[origin[0]+Math.round((point[0]-origin[0])*mx/gridStepRef.current)*gridStepRef.current/mx,origin[1]+Math.round((point[1]-origin[1])*my/gridStepRef.current)*gridStepRef.current/my];
        }
        const previous=pointsRef.current.at(-1);
        if(previous&&orthogonalRef.current){const factor=Math.max(.1,calibrationRef.current),mx=111320*Math.cos(previous[1]*Math.PI/180)*factor,my=110540*factor,dx=(point[0]-previous[0])*mx,dy=(point[1]-previous[1])*my;point=Math.abs(dx)>=Math.abs(dy)?[point[0],previous[1]]:[previous[0],point[1]]}
        const first=pointsRef.current[0];
        if(first&&pointsRef.current.length>=3){
          const firstPixel=instance.project(first),distance=Math.hypot(firstPixel.x-event.point.x,firstPixel.y-event.point.y);
          if(distance<18){completeRef.current();return;}
        }
        changeRef.current([...pointsRef.current,point]);
      });
      let dragged:{id:string;start:RoofPoint}|null=null;
      instance.on("mousedown",event=>{if(drawingRef.current||measurementEnabledRef.current||!instance.getLayer("roof-panels"))return;const hit=instance.queryRenderedFeatures(event.point,{layers:["roof-panels"]})[0];if(typeof hit?.properties?.id!=="string")return;dragged={id:hit.properties.id,start:[event.lngLat.lng,event.lngLat.lat]};panelSelectRef.current(dragged.id,false);instance.dragPan.disable();instance.getCanvas().style.cursor="grabbing"});
      instance.on("mouseup",event=>{if(!dragged)return;const finish:RoofPoint=[event.lngLat.lng,event.lngLat.lat],origin:RoofPoint=[(dragged.start[0]+finish[0])/2,(dragged.start[1]+finish[1])/2],east=(finish[0]-dragged.start[0])*111320*Math.cos(origin[1]*Math.PI/180)*calibrationRef.current,north=(finish[1]-dragged.start[1])*110540*calibrationRef.current;panelDragRef.current(dragged.id,east,north);dragged=null;instance.dragPan.enable();instance.getCanvas().style.cursor="grab"});
      instance.once("load",()=>setReady(true));
      map.current=instance;
    });
    return()=>{disposed=true;centerMarker.current?.remove();vertexMarkers.current.forEach(marker=>marker.remove());edgeMarkers.current.forEach(marker=>marker.remove());map.current?.remove();map.current=null};
  },[]);

  useEffect(()=>{const instance=map.current;if(!instance||!ready)return;instance.getCanvas().style.cursor=measurementEnabled?"crosshair":drawingEnabled?(editTool==="delete"?"not-allowed":"crosshair"):"grab"},[drawingEnabled,editTool,measurementEnabled,ready]);
  useEffect(()=>{if(!map.current||!ready)return;map.current.flyTo({center,zoom:19,duration:1200});void import("maplibre-gl").then(({Marker})=>{centerMarker.current?.remove();centerMarker.current=new Marker({color:"#ffc45c",scale:.75}).setLngLat(center).addTo(map.current!)})},[center,ready]);
  useEffect(()=>{const instance=map.current;if(!instance||!ready)return;instance.setLayoutProperty("satellite","visibility",basemap==="map"?"none":"visible");instance.setLayoutProperty("osm","visibility",basemap==="satellite"?"none":"visible");instance.setPaintProperty("osm","raster-opacity",basemap==="hybrid"?.38:1)},[basemap,ready]);
  useEffect(()=>{const instance=map.current;if(!instance||!ready)return;instance.easeTo({pitch:viewMode==="3d"?58:0,bearing:viewMode==="3d"?-24:0,zoom:viewMode==="3d"?19.2:19,duration:850});for(const id of ["roof-fill","roof-line","roof-panels"])if(instance.getLayer(id))instance.setLayoutProperty(id,"visibility",viewMode==="2d"?"visible":"none");for(const id of ["roof-3d-surfaces","roof-3d-panels"])if(instance.getLayer(id))instance.setLayoutProperty(id,"visibility",viewMode==="3d"?"visible":"none")},[viewMode,ready]);

  useEffect(()=>{
    const instance=map.current;if(!instance||!ready)return;
    const completed=surfaces.flatMap(surface=>[
      {type:"Feature" as const,properties:{name:surface.name},geometry:{type:"Polygon" as const,coordinates:[[...surface.points,surface.points[0]]]}},
      {type:"Feature" as const,properties:{name:surface.name},geometry:{type:"LineString" as const,coordinates:surface.points}},
      
    ]);
    const selected=new Set(selectedPanelIds),panelData=panels.map(panel=>({type:"Feature" as const,properties:{kind:"panel",id:panel.id,selected:selected.has(panel.id),invalid:Boolean(panelIssues[panel.id]?.length)},geometry:{type:"Polygon" as const,coordinates:[[...panel.corners,panel.corners[0]]]}}));
    const ring:RoofPoint[]=points.length>2?[...points,points[0]]:[];
    const data={type:"FeatureCollection" as const,features:[...completed,...panelData,{type:"Feature" as const,properties:{active:true},geometry:{type:"Polygon" as const,coordinates:[ring]}},{type:"Feature" as const,properties:{active:true},geometry:{type:"LineString" as const,coordinates:points}}]};
    const source=instance.getSource("roof") as GeoJSONSource|undefined;
    if(source)source.setData(data);else{
      instance.addSource("roof",{type:"geojson",data});
      instance.addLayer({id:"roof-fill",type:"fill",source:"roof",filter:["all",["==",["geometry-type"],"Polygon"],["!=",["get","kind"],"panel"]],paint:{"fill-color":["case",["get","active"],"#ffc857","#2de2b1"],"fill-opacity":.25}});
      instance.addLayer({id:"roof-line",type:"line",source:"roof",filter:["==",["geometry-type"],"LineString"],paint:{"line-color":["case",["get","active"],"#ffc857","#2de2b1"],"line-width":3}});
      instance.addLayer({id:"roof-panels",type:"fill",source:"roof",filter:["==",["get","kind"],"panel"],paint:{"fill-color":["case",["get","selected"],"#ffc857",["get","invalid"],"#ff647c","#176dc1"],"fill-opacity":.9,"fill-outline-color":"#e9f5ff"}});
      instance.addLayer({id:"roof-3d-surfaces",type:"fill-extrusion",source:"roof",filter:["all",["==",["geometry-type"],"Polygon"],["!=",["get","kind"],"panel"]],layout:{visibility:viewMode==="3d"?"visible":"none"},paint:{"fill-extrusion-color":"#334b43","fill-extrusion-height":1.1,"fill-extrusion-base":0,"fill-extrusion-opacity":.68,"fill-extrusion-vertical-gradient":true}});
      instance.addLayer({id:"roof-3d-panels",type:"fill-extrusion",source:"roof",filter:["==",["get","kind"],"panel"],layout:{visibility:viewMode==="3d"?"visible":"none"},paint:{"fill-extrusion-color":["case",["get","selected"],"#ffc857",["get","invalid"],"#ff647c","#1876c9"],"fill-extrusion-height":1.32,"fill-extrusion-base":1.12,"fill-extrusion-opacity":.96,"fill-extrusion-vertical-gradient":true}});
    }
    vertexMarkers.current.forEach(marker=>marker.remove());vertexMarkers.current=[];
    edgeMarkers.current.forEach(marker=>marker.remove());edgeMarkers.current=[];
    if(drawingEnabled)void import("maplibre-gl").then(({Marker})=>points.forEach((point,index)=>{
      const element=document.createElement("button");element.className=`roof-vertex ${index===0?"first":""}`;element.type="button";element.title=editTool==="delete"?"Usuń punkt":"Przeciągnij punkt";
      element.addEventListener("click",event=>{event.stopPropagation();if(toolRef.current==="delete")changeRef.current(pointsRef.current.filter((_,itemIndex)=>itemIndex!==index));else if(index===0&&pointsRef.current.length>=3)completeRef.current()});
      const marker=new Marker({element,draggable:editTool==="draw"}).setLngLat(point).addTo(instance);
      marker.on("dragend",()=>{const position=marker.getLngLat();changeRef.current(pointsRef.current.map((item,itemIndex)=>itemIndex===index?[position.lng,position.lat] as RoofPoint:item))});
      vertexMarkers.current.push(marker);
    }));
    void import("maplibre-gl").then(({Marker})=>[...surfaces.map(surface=>surface.points),...(points.length>=2?[points]:[])].forEach(polygon=>polygon.forEach((point,index)=>{
      const next=polygon[(index+1)%polygon.length];if(!next)return;
      const element=document.createElement("span");element.className="roof-edge-length";element.textContent=`${(mapDistanceMeters(point,next)*calibrationFactor).toFixed(2)} m`;
      const marker=new Marker({element,anchor:"center"}).setLngLat([(point[0]+next[0])/2,(point[1]+next[1])/2]).addTo(instance);edgeMarkers.current.push(marker);
    })));
    const timer=window.setTimeout(()=>{try{snapshotRef.current(instance.getCanvas().toDataURL("image/jpeg",.86))}catch{}},500);
    return()=>window.clearTimeout(timer);
  },[points,surfaces,panels,selectedPanelIds,panelIssues,drawingEnabled,editTool,calibrationFactor,ready]);

  useEffect(()=>{const instance=map.current;if(!instance||!ready)return;const data={type:"FeatureCollection" as const,features:obstacles.map(item=>{const polygon=obstaclePolygon(item,calibrationFactor);return {type:"Feature" as const,properties:{kind:item.kind,label:item.label},geometry:{type:"Polygon" as const,coordinates:[[...polygon,polygon[0]]]}}})};const source=instance.getSource("obstacles") as GeoJSONSource|undefined;if(source)source.setData(data);else{instance.addSource("obstacles",{type:"geojson",data});instance.addLayer({id:"obstacle-fill",type:"fill",source:"obstacles",paint:{"fill-color":["match",["get","kind"],"skylight","#4da3ff","tree","#2de2b1","#ff647c"],"fill-opacity":.38}});instance.addLayer({id:"obstacle-line",type:"line",source:"obstacles",paint:{"line-color":["match",["get","kind"],"skylight","#8bc4ff","tree","#69e6a6","#ff8a9d"],"line-width":3,"line-dasharray":[2,1]}})}},[obstacles,calibrationFactor,ready]);

  useEffect(()=>{const instance=map.current;if(!instance||!ready)return;const features=[...measurementPoints.map((point,index)=>({type:"Feature" as const,properties:{index},geometry:{type:"Point" as const,coordinates:point}})),...(measurementPoints.length===2?[{type:"Feature" as const,properties:{},geometry:{type:"LineString" as const,coordinates:measurementPoints}}]:[])];const data={type:"FeatureCollection" as const,features};const source=instance.getSource("measurement") as GeoJSONSource|undefined;if(source)source.setData(data);else{instance.addSource("measurement",{type:"geojson",data});instance.addLayer({id:"measurement-line",type:"line",source:"measurement",filter:["==",["geometry-type"],"LineString"],paint:{"line-color":"#ffc857","line-width":4,"line-dasharray":[2,1]}});instance.addLayer({id:"measurement-points",type:"circle",source:"measurement",filter:["==",["geometry-type"],"Point"],paint:{"circle-radius":7,"circle-color":"#ffc857","circle-stroke-color":"#07111f","circle-stroke-width":3}})}},[measurementPoints,ready]);

  useEffect(()=>{const instance=map.current;if(!instance||!ready)return;const factor=Math.max(.1,calibrationFactor),step=Math.max(.05,gridStepM),mx=111320*Math.cos(center[1]*Math.PI/180)*factor,my=110540*factor,extent=30,features=[];if(gridEnabled)for(let offset=-extent;offset<=extent+.001;offset+=step){features.push({type:"Feature" as const,properties:{major:Math.abs(offset%1)<.001},geometry:{type:"LineString" as const,coordinates:[[center[0]+offset/mx,center[1]-extent/my],[center[0]+offset/mx,center[1]+extent/my]]}});features.push({type:"Feature" as const,properties:{major:Math.abs(offset%1)<.001},geometry:{type:"LineString" as const,coordinates:[[center[0]-extent/mx,center[1]+offset/my],[center[0]+extent/mx,center[1]+offset/my]]}})}const data={type:"FeatureCollection" as const,features};const source=instance.getSource("metric-grid") as GeoJSONSource|undefined;if(source)source.setData(data);else{instance.addSource("metric-grid",{type:"geojson",data});instance.addLayer({id:"metric-grid",type:"line",source:"metric-grid",paint:{"line-color":["case",["get","major"],"#ffc857","#4da3ff"],"line-width":["case",["get","major"],1.2,.55],"line-opacity":["case",["get","major"],.42,.2]}},instance.getLayer("roof-fill")?"roof-fill":undefined)}},[center,gridEnabled,gridStepM,calibrationFactor,ready]);

  return <><div className="designer-map" ref={node}/><div className="basemap-switch" role="group" aria-label="Rodzaj mapy"><button className={basemap==="map"?"active":""} onClick={()=>setBasemap("map")}>Mapa</button><button className={basemap==="satellite"?"active":""} onClick={()=>setBasemap("satellite")}>Satelita</button><button className={basemap==="hybrid"?"active":""} onClick={()=>setBasemap("hybrid")}>Hybryda</button><span className="map-switch-divider"/><button className={viewMode==="2d"?"active":""} onClick={()=>setViewMode("2d")}>2D</button><button className={viewMode==="3d"?"active view-3d":""} onClick={()=>setViewMode("3d")}>3D</button></div></>;
}
