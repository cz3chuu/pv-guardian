import type {SolarPanel} from "./panel-layout";
import type {RoofPoint,RoofSurfaceMap} from "./roof-map";
import type {ShadowObstacle} from "./shadow-analysis";

type XY=[number,number];
function scale(origin:RoofPoint,calibrationFactor:number){const factor=Math.max(.1,calibrationFactor||1);return {mx:111320*Math.cos(origin[1]*Math.PI/180)*factor,my:110540*factor}}
function toXY(point:RoofPoint,origin:RoofPoint,calibrationFactor:number):XY{const {mx,my}=scale(origin,calibrationFactor);return [(point[0]-origin[0])*mx,(point[1]-origin[1])*my]}
function fromXY(point:XY,origin:RoofPoint,calibrationFactor:number):RoofPoint{const {mx,my}=scale(origin,calibrationFactor);return [origin[0]+point[0]/mx,origin[1]+point[1]/my]}
function inside([x,y]:XY,polygon:XY[]){let result=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const [xi,yi]=polygon[i],[xj,yj]=polygon[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)result=!result}return result}
function axes(polygon:XY[]){return polygon.map((point,index)=>{const next=polygon[(index+1)%polygon.length],dx=next[0]-point[0],dy=next[1]-point[1],length=Math.hypot(dx,dy)||1;return [-dy/length,dx/length] as XY})}
function overlaps(a:XY[],b:XY[]){return [...axes(a),...axes(b)].every(axis=>{const pa=a.map(point=>point[0]*axis[0]+point[1]*axis[1]),pb=b.map(point=>point[0]*axis[0]+point[1]*axis[1]);return Math.max(...pa)>Math.min(...pb)+1e-5&&Math.max(...pb)>Math.min(...pa)+1e-5})}

export function obstaclePolygon(obstacle:ShadowObstacle,calibrationFactor:number):RoofPoint[]{const origin:RoofPoint=[obstacle.longitude,obstacle.latitude],halfWidth=(obstacle.widthM+obstacle.safetyMarginM*2)/2,halfDepth=(obstacle.depthM+obstacle.safetyMarginM*2)/2;return [[-halfWidth,-halfDepth],[halfWidth,-halfDepth],[halfWidth,halfDepth],[-halfWidth,halfDepth]].map(point=>fromXY(point as XY,origin,calibrationFactor))}

export function validatePanels(panels:SolarPanel[],surfaces:RoofSurfaceMap[],obstacles:ShadowObstacle[],calibrationFactor:number){const issues:Record<string,string[]>={};for(const panel of panels){const list:string[]=[],surface=surfaces.find(item=>item.id===panel.surfaceId),origin=panel.center,panelXY=panel.corners.map(point=>toXY(point,origin,calibrationFactor));if(!surface||!panel.corners.every(corner=>inside(toXY(corner,origin,calibrationFactor),surface.points.map(point=>toXY(point,origin,calibrationFactor)))))list.push("Moduł wychodzi poza obrys połaci");for(const obstacle of obstacles){const polygon=obstaclePolygon(obstacle,calibrationFactor).map(point=>toXY(point,origin,calibrationFactor));if(overlaps(panelXY,polygon))list.push(`Kolizja: ${obstacle.label||obstacle.kind}`)}issues[panel.id]=list}
  for(let i=0;i<panels.length;i++)for(let j=i+1;j<panels.length;j++){const a=panels[i],b=panels[j],origin=a.center;if(overlaps(a.corners.map(point=>toXY(point,origin,calibrationFactor)),b.corners.map(point=>toXY(point,origin,calibrationFactor)))){issues[a.id].push(`Nakłada się z modułem ${j+1}`);issues[b.id].push(`Nakłada się z modułem ${i+1}`)}}
  return issues;
}
