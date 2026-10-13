"use client";

type Props={hasLocation:boolean;surfaceCount:number;panelCount:number;hasParameters:boolean;hasResult:boolean;advanced:boolean;onAdvanced:(value:boolean)=>void};
const stages=[
  {id:"roof",label:"Dach",hint:"Adres i obrys połaci"},
  {id:"layout",label:"Panele",hint:"Dobór i rozmieszczenie"},
  {id:"parameters",label:"Energia",hint:"Zużycie i magazyn"},
  {id:"finance",label:"Opłacalność",hint:"Wyniki i finanse"},
  {id:"report",label:"Raport",hint:"Dokument końcowy"},
];

export function ProjectWorkflow({hasLocation,surfaceCount,panelCount,hasParameters,hasResult,advanced,onAdvanced}:Props){
  const complete=[hasLocation&&surfaceCount>0,panelCount>0,hasParameters,hasResult,false];
  const current=Math.max(0,complete.findIndex(value=>!value));
  const go=(id:string)=>(document.getElementById(id)??(id==="layout"?document.querySelector(".panel-layout-editor"):null))?.scrollIntoView({behavior:"smooth",block:"start"});
  return <section className="project-workflow no-print" aria-label="Etapy projektu">
    <div className="workflow-intro"><div><p className="eyebrow">Plan projektu</p><h2>Przejdź kolejno przez 5 etapów</h2><p>Nie musisz wypełniać wszystkiego naraz. Żółty etap wskazuje, czym warto zająć się teraz.</p></div><div className="workflow-actions"><button type="button" className={advanced?"active":""} onClick={()=>onAdvanced(!advanced)}>{advanced?"✓ Tryb profesjonalny":"Włącz tryb profesjonalny"}</button><div className="workflow-progress"><strong>{complete.filter(Boolean).length}/5</strong><span>ukończonych etapów</span></div></div></div>
    <div className="workflow-stages">{stages.map((stage,index)=><button type="button" key={stage.id} className={complete[index]?"complete":index===current?"current":""} onClick={()=>go(stage.id)}><i>{complete[index]?"✓":index+1}</i><span><strong>{stage.label}</strong><small>{stage.hint}</small></span>{index===current&&<em>TERAZ</em>}</button>)}</div>
    <div className="workflow-next"><span>Następne zadanie</span><strong>{current===0?"Wyszukaj adres i zapisz co najmniej jedną połać dachu":current===1?"Dobierz moduł i rozmieść panele na zapisanych połaciach":current===2?"Ustaw zużycie energii, moc oraz magazyn":current===3?"Sprawdź produkcję, autokonsumpcję i okres zwrotu":"Uzupełnij dane klienta i wygeneruj raport"}</strong><button type="button" onClick={()=>go(stages[current]?.id??"report")}>Przejdź do zadania ↓</button></div>
  </section>;
}
