import type {RoofPoint,RoofSurfaceMap} from "./roof-map";

export type PanelOrientation="portrait"|"landscape";
export type PanelSettings={widthM:number;heightM:number;powerWp:number;gapM:number;marginM:number;rotationDeg:number;orientation:PanelOrientation;calibrationFactor:number;offsetXM?:number;offsetYM?:number};
export type SolarPanel={id:string;surfaceId:string;corners:RoofPoint[];center:RoofPoint;rotationDeg:number;orientation:PanelOrientation;powerWp:number;widthM:number;heightM:number};

type XY=[number,number];
const EARTH_LAT_M=110540;
function scale(origin:RoofPoint){return {mx:111320*Math.cos(origin[1]*Math.PI/180),my:EARTH_LAT_M}}
function toXY(point:RoofPoint,origin:RoofPoint,calibrationFactor=1):XY{const {mx,my}=scale(origin);return [(point[0]-origin[0])*mx*calibrationFactor,(point[1]-origin[1])*my*calibrationFactor]}
function toLngLat(point:XY,origin:RoofPoint,calibrationFactor=1):RoofPoint{const {mx,my}=scale(origin);return [origin[0]+point[0]/mx/calibrationFactor,origin[1]+point[1]/my/calibrationFactor]}
function rotate([x,y]:XY,angle:number):XY{const c=Math.cos(angle),s=Math.sin(angle);return [x*c-y*s,x*s+y*c]}
function pointInPolygon([x,y]:XY,polygon:XY[]){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const [xi,yi]=polygon[i],[xj,yj]=polygon[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside}return inside}
function distanceToSegment(point:XY,a:XY,b:XY){const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;if(!length)return Math.hypot(point[0]-a[0],point[1]-a[1]);const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length));return Math.hypot(point[0]-(a[0]+t*dx),point[1]-(a[1]+t*dy))}
function safelyInside(corners:XY[],polygon:XY[],margin:number){return corners.every(corner=>pointInPolygon(corner,polygon)&&polygon.every((point,index)=>distanceToSegment(corner,point,polygon[(index+1)%polygon.length])>=margin-1e-6))}

export function layoutPanels(surface:RoofSurfaceMap,settings:PanelSettings):SolarPanel[]{
  if(surface.points.length<3)return [];
  const origin:RoofPoint=[surface.points.reduce((sum,p)=>sum+p[0],0)/surface.points.length,surface.points.reduce((sum,p)=>sum+p[1],0)/surface.points.length];
  const calibrationFactor=Math.max(.1,settings.calibrationFactor||1);
  const angle=settings.rotationDeg*Math.PI/180,polygon=surface.points.map(point=>rotate(toXY(point,origin,calibrationFactor),-angle));
  const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const width=settings.orientation==="portrait"?settings.widthM:settings.heightM,height=settings.orientation==="portrait"?settings.heightM:settings.widthM;
  const panels:SolarPanel[]=[];let row=0;
  for(let y=minY+settings.marginM+height/2+(settings.offsetYM??0);y<=maxY-settings.marginM-height/2+1e-6;y+=height+settings.gapM,row++){
    let column=0;
    for(let x=minX+settings.marginM+width/2+(settings.offsetXM??0);x<=maxX-settings.marginM-width/2+1e-6;x+=width+settings.gapM,column++){
      const localCorners:XY[]=[[x-width/2,y-height/2],[x+width/2,y-height/2],[x+width/2,y+height/2],[x-width/2,y+height/2]];
      if(!safelyInside(localCorners,polygon,settings.marginM))continue;
      const corners=localCorners.map(point=>toLngLat(rotate(point,angle),origin,calibrationFactor));
      panels.push({id:`${surface.id}:${row}:${column}:${settings.orientation}:${settings.rotationDeg}`,surfaceId:surface.id,corners,center:toLngLat(rotate([x,y],angle),origin,calibrationFactor),rotationDeg:settings.rotationDeg,orientation:settings.orientation,powerWp:settings.powerWp,widthM:width,heightM:height});
    }
  }
  return panels;
}

export function layoutAllPanels(surfaces:RoofSurfaceMap[],settings:PanelSettings){return surfaces.flatMap(surface=>layoutPanels(surface,settings))}

export function mapDistanceMeters(a:RoofPoint,b:RoofPoint){const origin:RoofPoint=[(a[0]+b[0])/2,(a[1]+b[1])/2],first=toXY(a,origin),second=toXY(b,origin);return Math.hypot(second[0]-first[0],second[1]-first[1])}

export function translatePanels(panels:SolarPanel[],ids:Set<string>,eastM:number,northM:number,calibrationFactor:number){const factor=Math.max(.1,calibrationFactor||1);return panels.map(panel=>{if(!ids.has(panel.id))return panel;const origin=panel.center,move=(point:RoofPoint):RoofPoint=>{const xy=toXY(point,origin,factor);return toLngLat([xy[0]+eastM,xy[1]+northM],origin,factor)};return {...panel,center:move(panel.center),corners:panel.corners.map(move)}})}

export function rotatePanels(panels:SolarPanel[],ids:Set<string>,angleDeg:number,calibrationFactor:number){const selected=panels.filter(panel=>ids.has(panel.id));if(!selected.length)return panels;const origin:RoofPoint=[selected.reduce((sum,panel)=>sum+panel.center[0],0)/selected.length,selected.reduce((sum,panel)=>sum+panel.center[1],0)/selected.length],factor=Math.max(.1,calibrationFactor||1),angle=angleDeg*Math.PI/180,turn=(point:RoofPoint)=>toLngLat(rotate(toXY(point,origin,factor),angle),origin,factor);return panels.map(panel=>ids.has(panel.id)?{...panel,center:turn(panel.center),corners:panel.corners.map(turn),rotationDeg:(panel.rotationDeg+angleDeg+360)%360}:panel)}
