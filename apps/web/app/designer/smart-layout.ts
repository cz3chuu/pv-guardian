import {layoutAllPanels,type PanelSettings,type SolarPanel} from "./panel-layout";
import {validatePanels} from "./panel-validation";
import type {RoofSurfaceMap} from "./roof-map";
import type {ShadowObstacle} from "./shadow-analysis";

export type SmartLayoutVariant={id:"maximum"|"balanced"|"aesthetic"|"target";label:string;description:string;panels:SolarPanel[];powerKwp:number;orientation:string;rotationDeg:number;utilizationPct:number};
type Candidate={panels:SolarPanel[];settings:PanelSettings;power:number;rowPenalty:number;rotationPenalty:number};

function cleanLayout(surfaces:RoofSurfaceMap[],obstacles:ShadowObstacle[],settings:PanelSettings){const panels=layoutAllPanels(surfaces,settings),issues=validatePanels(panels,surfaces,obstacles,settings.calibrationFactor);return panels.filter(panel=>!(issues[panel.id]?.length))}
function rowPenalty(panels:SolarPanel[]){if(!panels.length)return 999;const rows=new Map<string,number>();for(const panel of panels){const key=`${panel.surfaceId}:${panel.center[1].toFixed(5)}`;rows.set(key,(rows.get(key)??0)+1)}const counts=[...rows.values()],average=counts.reduce((a,b)=>a+b,0)/counts.length;return counts.reduce((sum,count)=>sum+Math.abs(count-average),0)}

export function generateSmartLayouts(surfaces:RoofSurfaceMap[],obstacles:ShadowObstacle[],base:PanelSettings,targetPowerKwp:number,roofAreaM2:number):SmartLayoutVariant[]{
  const candidates:Candidate[]=[],angles=Array.from(new Set([base.rotationDeg,...Array.from({length:13},(_,index)=>-90+index*15)]));
  for(const orientation of ["portrait","landscape"] as const){const width=orientation==="portrait"?base.widthM:base.heightM,height=orientation==="portrait"?base.heightM:base.widthM;for(const rotationDeg of angles)for(const offsetRatioX of [0,.25,.5,.75])for(const offsetRatioY of [0,.5]){const settings={...base,orientation,rotationDeg,offsetXM:(width+base.gapM)*offsetRatioX,offsetYM:(height+base.gapM)*offsetRatioY},panels=cleanLayout(surfaces,obstacles,settings);if(!panels.length)continue;candidates.push({panels,settings,power:panels.length*base.powerWp/1000,rowPenalty:rowPenalty(panels),rotationPenalty:Math.abs(rotationDeg-base.rotationDeg)})}}
  if(!candidates.length)return [];
  const maximum=[...candidates].sort((a,b)=>b.power-a.power||a.rowPenalty-b.rowPenalty)[0];
  const aesthetic=[...candidates].sort((a,b)=>(a.rowPenalty+a.rotationPenalty*.08)-(b.rowPenalty+b.rotationPenalty*.08)||b.power-a.power)[0];
  const balanced=[...candidates].sort((a,b)=>(b.power-b.rotationPenalty*.006-b.rowPenalty*.015)-(a.power-a.rotationPenalty*.006-a.rowPenalty*.015))[0];
  const target=[...candidates].sort((a,b)=>Math.abs(a.power-targetPowerKwp)-Math.abs(b.power-targetPowerKwp)||a.rowPenalty-b.rowPenalty)[0];
  const make=(id:SmartLayoutVariant["id"],label:string,description:string,candidate:Candidate):SmartLayoutVariant=>({id,label,description,panels:candidate.panels,powerKwp:candidate.power,orientation:candidate.settings.orientation==="portrait"?"Pionowa":"Pozioma",rotationDeg:candidate.settings.rotationDeg,utilizationPct:roofAreaM2?Math.min(100,candidate.panels.reduce((sum,panel)=>sum+panel.widthM*panel.heightM,0)/roofAreaM2*100):0});
  return [make("maximum","Maksymalna moc","Najwięcej poprawnych modułów mieszczących się na dachu.",maximum),make("balanced","Optymalny","Kompromis mocy, kierunku montażu i regularności rzędów.",balanced),make("aesthetic","Estetyczny","Najbardziej regularne rzędy i najmniejsza zmiana kierunku.",aesthetic),make("target","Zadana moc",`Układ najbliższy wartości ${targetPowerKwp.toFixed(1)} kWp.`,target)];
}
