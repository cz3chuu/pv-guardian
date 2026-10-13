"use client";
import {useMemo,useState} from "react";
import type {SolarPanel} from "./panel-layout";
import type {PvInverter,PvModule} from "./pv-device-data";

export type StringAssignments=Record<string,string>;
type StringSlot={id:string;mppt:number;input:number};
const slotName=(slot:StringSlot)=>`MPPT ${slot.mppt}.${slot.input}`;

export function StringDesigner({panels,selectedPanelIds,module,inverter,assignments,onAssignments}:{panels:SolarPanel[];selectedPanelIds:string[];module:PvModule;inverter:PvInverter;assignments:StringAssignments;onAssignments:(next:StringAssignments)=>void}){
  const [minTemp,setMinTemp]=useState(-20),[maxTemp,setMaxTemp]=useState(70);
  const slots=useMemo(()=>Array.from({length:inverter.mpptCount},(_,mppt)=>Array.from({length:inverter.stringsPerMppt},(_,input)=>({id:`m${mppt+1}s${input+1}`,mppt:mppt+1,input:input+1}))).flat(),[inverter]);
  const analysis=useMemo(()=>slots.map(slot=>{
    const count=panels.filter(panel=>assignments[panel.id]===slot.id).length;
    const coldVoc=count*module.vocV*(1+Math.abs(module.tempCoeffVocPctC)*(25-minTemp)/100);
    const hotVmp=count*module.vmpV*(1-Math.abs(module.tempCoeffVocPctC)*(maxTemp-25)/100);
    const errors:string[]=[];
    if(count&&coldVoc>inverter.maxDcVoltageV)errors.push("Voc przekracza limit DC");
    if(count&&hotVmp<inverter.mpptMinV)errors.push("Vmp poniżej zakresu MPPT");
    if(count&&hotVmp>inverter.mpptMaxV)errors.push("Vmp powyżej zakresu MPPT");
    return {...slot,count,coldVoc,hotVmp,errors};
  }),[slots,panels,assignments,module,inverter,minTemp,maxTemp]);
  const mpptCurrent=Array.from({length:inverter.mpptCount},(_,index)=>{const active=analysis.filter(item=>item.mppt===index+1&&item.count>0).length;return {mppt:index+1,current:active*module.iscA,invalid:active*module.iscA>inverter.maxInputCurrentPerMpptA}});
  const unassigned=panels.filter(panel=>!assignments[panel.id]).length;
  const allErrors=analysis.reduce((sum,item)=>sum+item.errors.length,0)+mpptCurrent.filter(item=>item.invalid).length;
  function assign(ids:string[],slotId:string){const next={...assignments};ids.forEach(id=>next[id]=slotId);onAssignments(next)}
  function autoAssign(){const next:StringAssignments={};panels.forEach((panel,index)=>next[panel.id]=slots[index%slots.length].id);onAssignments(next)}
  return <section className="string-designer">
    <div className="string-head"><div><span>Projekt elektryczny</span><strong>Stringi i wejścia MPPT</strong><p>{module.manufacturer} {module.model} + {inverter.manufacturer} {inverter.model}</p></div><div className="temperature-inputs"><label>Min. temperatura<input type="number" value={minTemp} onChange={e=>setMinTemp(+e.target.value)}/>°C</label><label>Temp. ogniwa latem<input type="number" value={maxTemp} onChange={e=>setMaxTemp(+e.target.value)}/>°C</label></div></div>
    <div className="string-toolbar"><button onClick={autoAssign} disabled={!panels.length}>Automatyczny podział</button><button onClick={()=>onAssignments({})} disabled={!Object.keys(assignments).length}>Wyczyść stringi</button><span>Zaznaczono <b>{selectedPanelIds.length}</b> · bez stringu <b>{unassigned}</b></span></div>
    <div className="string-grid">{analysis.map(item=><article className={item.errors.length?"invalid":item.count?"valid":""} key={item.id}><div><span>{slotName(item)}</span><b>{item.count} modułów</b></div><dl><div><dt>Voc przy {minTemp}°C</dt><dd>{item.coldVoc.toFixed(1)} V</dd></div><div><dt>Vmp przy {maxTemp}°C</dt><dd>{item.hotVmp.toFixed(1)} V</dd></div><div><dt>Moc stringu</dt><dd>{(item.count*module.powerWp/1000).toFixed(2)} kWp</dd></div></dl>{item.errors.map(error=><small key={error}>{error}</small>)}<button disabled={!selectedPanelIds.length} onClick={()=>assign(selectedPanelIds,item.id)}>Przypisz zaznaczone</button></article>)}</div>
    <div className="mppt-checks">{mpptCurrent.map(item=><div className={item.invalid?"invalid":"valid"} key={item.mppt}><span>MPPT {item.mppt} · prąd zwarciowy</span><strong>{item.current.toFixed(2)} A / {inverter.maxInputCurrentPerMpptA} A</strong><b>{item.invalid?"PRZEKROCZONY":"OK"}</b></div>)}</div>
    <div className={`electrical-summary ${allErrors?"invalid":"valid"}`}><strong>{allErrors?`${allErrors} problemów elektrycznych`:"Konfiguracja w dopuszczalnym zakresie"}</strong><span>{unassigned?`${unassigned} modułów wymaga przypisania do stringu.`:"Wszystkie moduły przypisane."}</span><small>Obliczenia są kontrolą projektową. Przed wykonaniem instalacji wymagane jest zatwierdzenie przez osobę z odpowiednimi uprawnieniami.</small></div>
  </section>
}
