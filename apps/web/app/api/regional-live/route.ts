import {NextResponse} from "next/server";
import {prisma} from "@pv-guardian/db";
import {esriRingsToMultiPolygon,insideMultiPolygon,nearestRegion,PV_REGIONS,type MultiPolygonCoordinates,type PvRegionDefinition} from "../../lib/pv-regions";

export const dynamic="force-dynamic";

/**
 * Produkcja PV w wojewodztwach i w Polsce:
 * - wojewodztwa: prognoza Open-Meteo (promieniowanie na panelu 35 st., poludnie)
 *   usredniona z siatki punktow wewnatrz granic (GUGiK PRG) + stolica,
 * - Polska: rzeczywista generacja PV i prognoza PSE (raporty.pse.pl).
 */

const TILT=35,AZIMUTH=0,PERFORMANCE_RATIO=.86; // typowy dach w PL, straty systemowe ~14%
type Boundary={teryt:string;name:string;polygons:MultiPolygonCoordinates};
type Point={latitude:number;longitude:number;regionId:string;capital:boolean};
type OpenMeteo={hourly:{time:string[];global_tilted_irradiance:(number|null)[];temperature_2m:(number|null)[];cloud_cover:(number|null)[]};current?:{cloud_cover:number;weather_code:number}};
type HourValue={time:string;kwh_per_kwp:number;cloud_cover:number};

const cache=new Map<string,{expires:number;value:unknown}>();
async function cached<T>(key:string,ttlMs:number,load:()=>Promise<T>):Promise<T>{const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value as T;try{const value=await load();cache.set(key,{expires:Date.now()+ttlMs,value});return value}catch(error){if(hit)return hit.value as T;throw error}}

const warsawDate=(date:Date)=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Warsaw",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
const warsawHour=(date:Date)=>Number(new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Warsaw",hourCycle:"h23",hour:"numeric"}).format(date))%24;

async function loadBoundaries():Promise<Boundary[]|null>{
  const params=new URLSearchParams({where:"1=1",outFields:"nazwa,teryt",returnGeometry:"true",outSR:"4326",geometryPrecision:"4",f:"json"});
  const response=await fetch(`https://mapy.geoportal.gov.pl/wss/ims/maps/PRG_gugik_wyszukiwarka/MapServer/2/query?${params}`,{cache:"no-store"});
  if(!response.ok)return null;
  const body=await response.json() as {features?:Array<{attributes:{nazwa:string;teryt:string};geometry:{rings:number[][][]}}>};
  const boundaries=(body.features??[]).map(feature=>({teryt:feature.attributes.teryt,name:feature.attributes.nazwa,polygons:esriRingsToMultiPolygon(feature.geometry.rings)}));
  return boundaries.length===16?boundaries:null;
}

/** Siatka ~0.5 x 0.75 st. (~55 km) wewnatrz granic + stolice wojewodztw. */
function samplingPoints(boundaries:Boundary[]|null):Point[]{
  const points:Point[]=PV_REGIONS.map(region=>({latitude:region.latitude,longitude:region.longitude,regionId:region.id,capital:true}));
  if(!boundaries)return points;
  const byTeryt=new Map(PV_REGIONS.map(region=>[region.teryt,region]));
  for(let latitude=49.15;latitude<=54.85;latitude+=.5)for(let longitude=14.25;longitude<=24.15;longitude+=.75){
    const boundary=boundaries.find(item=>insideMultiPolygon(longitude,latitude,item.polygons));
    const region=boundary&&byTeryt.get(boundary.teryt);
    if(region)points.push({latitude:Number(latitude.toFixed(2)),longitude:Number(longitude.toFixed(2)),regionId:region.id,capital:false});
  }
  return points;
}

/** kWh/kWp w kolejnych godzinach (poczatek przedzialu, czas lokalny): POA/1000 * PR * wspolczynnik temperaturowy. */
function hourlyYield(series:OpenMeteo):HourValue[]{
  const {time,global_tilted_irradiance:poa,temperature_2m:temp,cloud_cover:cloud}=series.hourly;
  // promieniowanie w Open-Meteo to srednia z POPRZEDNIEJ godziny -> wartosc z i+1 dotyczy przedzialu [i, i+1)
  return time.slice(0,-1).map((label,i)=>{const irradiance=Math.max(0,poa[i+1]??0),airTemperature=((temp[i]??10)+(temp[i+1]??10))/2,cellTemperature=airTemperature+.03*irradiance,temperatureFactor=Math.min(1.15,Math.max(.75,1-.004*(cellTemperature-25)));return {time:label,kwh_per_kwp:irradiance/1000*PERFORMANCE_RATIO*temperatureFactor,cloud_cover:cloud[i]??0}});
}

async function loadWeather(points:Point[]):Promise<OpenMeteo[]>{
  const params=new URLSearchParams({latitude:points.map(p=>p.latitude).join(","),longitude:points.map(p=>p.longitude).join(","),hourly:"global_tilted_irradiance,temperature_2m,cloud_cover",current:"cloud_cover,weather_code",tilt:String(TILT),azimuth:String(AZIMUTH),forecast_days:"3",timezone:"Europe/Warsaw"});
  const response=await fetch(`https://api.open-meteo.com/v1/forecast?${params}`,{cache:"no-store"});
  if(!response.ok)throw new Error(`Open-Meteo ${response.status}`);
  const body=await response.json();
  return Array.isArray(body)?body:[body];
}

type PseHour={hour:number;mw:number|null};
async function loadPse(today:string,tomorrow:string){
  const select=(endpoint:string,filter:string,fields:string)=>fetch(`https://api.raporty.pse.pl/api/${endpoint}?${new URLSearchParams({$filter:filter,$select:fields,$first:"5000"})}`,{cache:"no-store",headers:{Accept:"application/json"}}).then(async response=>{if(!response.ok)throw new Error(`PSE ${endpoint} ${response.status}`);return ((await response.json()) as {value:Array<Record<string,string|number|null>>}).value??[]});
  const [actualRows,forecastRows]=await Promise.all([
    select("his-wlk-cal",`business_date eq '${today}'`,"period,pv,demand,business_date"),
    select("pk5l-wp",`business_date ge '${today}' and business_date le '${tomorrow}'`,"period,business_date,fcst_pv_tot_gen,publication_ts"),
  ]);
  // rzeczywiste: okresy 15-min -> srednia moc w godzinie
  const actual:PseHour[]=Array.from({length:24},(_,hour)=>{const rows=actualRows.filter(row=>Number(String(row.period).slice(0,2))===hour&&row.pv!==null);return {hour,mw:rows.length===4?rows.reduce((sum,row)=>sum+Number(row.pv),0)/4:null}});
  const latest=[...actualRows].filter(row=>row.pv!==null).sort((a,b)=>String(a.period).localeCompare(String(b.period))).at(-1);
  // prognoza: kilka publikacji planu na dzien -- bierzemy najnowsza dla kazdej godziny
  const newest=new Map<string,Record<string,string|number|null>>();
  for(const row of forecastRows){const key=`${row.business_date}|${row.period}`,current=newest.get(key);if(!current||String(row.publication_ts)>String(current.publication_ts))newest.set(key,row)}
  const forecastFor=(date:string):PseHour[]=>Array.from({length:24},(_,hour)=>{const row=[...newest.values()].find(item=>item.business_date===date&&Number(String(item.period).slice(0,2))===hour);return {hour,mw:row&&row.fcst_pv_tot_gen!==null?Number(row.fcst_pv_tot_gen):null}});
  const forecastToday=forecastFor(today),forecastTomorrow=forecastFor(tomorrow);
  const sum=(hours:PseHour[])=>hours.reduce((total,item)=>total+(item.mw??0),0)/1000; // MWh -> GWh
  return {
    source:"PSE (raporty.pse.pl)",
    current_mw:latest?Number(latest.pv):null,
    current_period:latest?String(latest.period):null,
    current_demand_mw:latest?Number(latest.demand):null,
    actual_hours:actual,
    forecast_today_hours:forecastToday,
    forecast_tomorrow_hours:forecastTomorrow,
    today_actual_gwh:Number(sum(actual).toFixed(2)),
    today_forecast_gwh:Number(sum(forecastToday).toFixed(2)),
    tomorrow_forecast_gwh:Number(sum(forecastTomorrow).toFixed(2)),
  };
}

function regionFor(latitude:number,longitude:number,boundaries:Boundary[]|null):PvRegionDefinition{
  const boundary=boundaries?.find(item=>insideMultiPolygon(longitude,latitude,item.polygons));
  return (boundary&&PV_REGIONS.find(region=>region.teryt===boundary.teryt))??nearestRegion(latitude,longitude);
}

export async function GET(){
  try{
    const now=new Date(),today=warsawDate(now),tomorrow=warsawDate(new Date(now.getTime()+86_400_000));
    const boundaries=await cached("boundaries",86_400_000,loadBoundaries).catch(()=>null);
    const points=samplingPoints(boundaries);
    const since=new Date(Date.now()-14*86_400_000);
    const [weather,pse,installations,anomalies]=await Promise.all([
      // ~100 punktow; godzinowy cache trzyma nas w darmowym limicie Open-Meteo
      cached(`weather:${today}:${points.length}`,3_600_000,()=>loadWeather(points)),
      cached(`pse:${today}`,15*60_000,()=>loadPse(today,tomorrow)).catch(error=>({error:error instanceof Error?error.message:String(error)})),
      prisma.installation.findMany({select:{latitude:true,longitude:true,peakPowerKwp:true}}).catch(()=>[]),
      prisma.anomaly.findMany({where:{periodStart:{gte:since},status:"open"},select:{installation:{select:{latitude:true,longitude:true}}}}).catch(()=>[]),
    ]);
    const yields=weather.map(hourlyYield);
    const regions=PV_REGIONS.map(region=>{
      const indices=points.map((point,index)=>point.regionId===region.id?index:-1).filter(index=>index>=0);
      const capitalIndex=points.findIndex(point=>point.regionId===region.id&&point.capital);
      const hourCount=yields[capitalIndex].length;
      const averaged:HourValue[]=Array.from({length:hourCount},(_,h)=>({time:yields[capitalIndex][h].time,kwh_per_kwp:indices.reduce((sum,i)=>sum+(yields[i][h]?.kwh_per_kwp??0),0)/indices.length,cloud_cover:indices.reduce((sum,i)=>sum+(yields[i][h]?.cloud_cover??0),0)/indices.length}));
      const daySum=(series:HourValue[],date:string)=>series.filter(item=>item.time.startsWith(date)).reduce((sum,item)=>sum+item.kwh_per_kwp,0);
      const localInstallations=installations.filter(item=>regionFor(item.latitude,item.longitude,boundaries).id===region.id);
      const current=weather[capitalIndex].current;
      return {...region,
        sample_points:indices.length,
        today_yield_kwh_per_kwp:Number(daySum(averaged,today).toFixed(2)),
        tomorrow_yield_kwh_per_kwp:Number(daySum(averaged,tomorrow).toFixed(2)),
        capital_today_kwh_per_kwp:Number(daySum(yields[capitalIndex],today).toFixed(2)),
        capital_tomorrow_kwh_per_kwp:Number(daySum(yields[capitalIndex],tomorrow).toFixed(2)),
        cloud_cover:current?.cloud_cover??null,weather_code:current?.weather_code??null,
        installation_count:localInstallations.length,
        installed_kwp:Number(localInstallations.reduce((sum,item)=>sum+item.peakPowerKwp,0).toFixed(1)),
        open_anomalies:anomalies.filter(item=>regionFor(item.installation.latitude,item.installation.longitude,boundaries).id===region.id).length,
        hours:averaged.filter(item=>item.time.startsWith(today)).map(item=>({time:item.time,power_kw_per_kwp:Number(item.kwh_per_kwp.toFixed(3)),cloud_cover:Math.round(item.cloud_cover)})),
      };
    });
    const average=regions.reduce((sum,item)=>sum+item.today_yield_kwh_per_kwp,0)/regions.length;
    return NextResponse.json({
      updated_at:new Date().toISOString(),
      local_hour:warsawHour(now),
      today,tomorrow,
      national_average_kwh_per_kwp:Number(average.toFixed(2)),
      national:pse,
      boundaries:boundaries?{type:"FeatureCollection",features:boundaries.map(item=>({type:"Feature",properties:{name:item.name,teryt:item.teryt},geometry:{type:"MultiPolygon",coordinates:item.polygons}}))}:null,
      method:`Prognoza Open-Meteo dla paneli ${TILT}° na południe, PR ${PERFORMANCE_RATIO} z poprawką temperaturową; średnia z ${points.length} punktów (${boundaries?"siatka w granicach województw GUGiK":"tylko stolice — granice GUGiK niedostępne"}).`,
      regions,
    });
  }catch(error){return NextResponse.json({detail:error instanceof Error?error.message:"Nie udało się pobrać danych regionalnych"},{status:502})}
}
