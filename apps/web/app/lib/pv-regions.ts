export type PvRegionDefinition={id:string;teryt:string;name:string;capital:string;latitude:number;longitude:number};

export const PV_REGIONS:PvRegionDefinition[]=[
  {id:"dolnoslaskie",teryt:"02",name:"Dolnośląskie",capital:"Wrocław",latitude:51.1079,longitude:17.0385},
  {id:"kujawsko-pomorskie",teryt:"04",name:"Kujawsko-pomorskie",capital:"Toruń",latitude:53.0138,longitude:18.5984},
  {id:"lubelskie",teryt:"06",name:"Lubelskie",capital:"Lublin",latitude:51.2465,longitude:22.5684},
  {id:"lubuskie",teryt:"08",name:"Lubuskie",capital:"Zielona Góra",latitude:51.9356,longitude:15.5062},
  {id:"lodzkie",teryt:"10",name:"Łódzkie",capital:"Łódź",latitude:51.7592,longitude:19.4560},
  {id:"malopolskie",teryt:"12",name:"Małopolskie",capital:"Kraków",latitude:50.0647,longitude:19.9450},
  {id:"mazowieckie",teryt:"14",name:"Mazowieckie",capital:"Warszawa",latitude:52.2297,longitude:21.0122},
  {id:"opolskie",teryt:"16",name:"Opolskie",capital:"Opole",latitude:50.6751,longitude:17.9213},
  {id:"podkarpackie",teryt:"18",name:"Podkarpackie",capital:"Rzeszów",latitude:50.0412,longitude:21.9991},
  {id:"podlaskie",teryt:"20",name:"Podlaskie",capital:"Białystok",latitude:53.1325,longitude:23.1688},
  {id:"pomorskie",teryt:"22",name:"Pomorskie",capital:"Gdańsk",latitude:54.3520,longitude:18.6466},
  {id:"slaskie",teryt:"24",name:"Śląskie",capital:"Katowice",latitude:50.2649,longitude:19.0238},
  {id:"swietokrzyskie",teryt:"26",name:"Świętokrzyskie",capital:"Kielce",latitude:50.8661,longitude:20.6286},
  {id:"warminsko-mazurskie",teryt:"28",name:"Warmińsko-mazurskie",capital:"Olsztyn",latitude:53.7784,longitude:20.4801},
  {id:"wielkopolskie",teryt:"30",name:"Wielkopolskie",capital:"Poznań",latitude:52.4064,longitude:16.9252},
  {id:"zachodniopomorskie",teryt:"32",name:"Zachodniopomorskie",capital:"Szczecin",latitude:53.4285,longitude:14.5528},
];

/** Najblizsza stolica wojewodztwa -- przyblizenie, gdy granice z GUGiK sa niedostepne. */
export function nearestRegion(latitude:number,longitude:number){return PV_REGIONS.reduce((best,item)=>{const distance=(item.latitude-latitude)**2+((item.longitude-longitude)*Math.cos(latitude*Math.PI/180))**2;return distance<best.distance?{item,distance}:best;},{item:PV_REGIONS[0],distance:Infinity}).item;}

type Ring=number[][];
/** MultiPolygon w konwencji GeoJSON: [[pierscien zewnetrzny, ...dziury], ...] */
export type MultiPolygonCoordinates=Ring[][];

function insideRing(longitude:number,latitude:number,ring:Ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>latitude)!==(yj>latitude)&&longitude<(xj-xi)*(latitude-yi)/(yj-yi)+xi)inside=!inside}return inside}

export function insideMultiPolygon(longitude:number,latitude:number,polygons:MultiPolygonCoordinates){return polygons.some(([outer,...holes])=>insideRing(longitude,latitude,outer)&&!holes.some(hole=>insideRing(longitude,latitude,hole)))}

function signedArea(ring:Ring){let area=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)area+=(ring[j][0]-ring[i][0])*(ring[j][1]+ring[i][1]);return area/2}

/**
 * Pierscienie Esri JSON -> MultiPolygon GeoJSON. W Esri pierscienie
 * zewnetrzne sa zgodne z ruchem wskazowek zegara, dziury przeciwnie; kilka
 * pierscieni zewnetrznych to kilka czesci (np. eksklawy), a nie dziury.
 * Wynik w orientacji RFC 7946 (zewnetrzne przeciwnie do wskazowek).
 */
export function esriRingsToMultiPolygon(rings:Ring[]):MultiPolygonCoordinates{const valid=rings.filter(ring=>ring.length>=4);if(!valid.length)return [];
  // orientacje wzgledem najwiekszego pierscienia (zawsze zewnetrznego) -- niezaleznie od konwencji zrodla
  const largest=valid.reduce((best,ring)=>Math.abs(signedArea(ring))>Math.abs(signedArea(best))?ring:best),outerSign=Math.sign(signedArea(largest));
  const ccw=(ring:Ring)=>signedArea(ring)>0?ring:[...ring].reverse(),cw=(ring:Ring)=>signedArea(ring)<0?ring:[...ring].reverse();
  const outers:Ring[][]=[],holes:Ring[]=[];for(const ring of valid){if(Math.sign(signedArea(ring))===outerSign)outers.push([ccw(ring)]);else holes.push(cw(ring))}
  for(const hole of holes){const owner=outers.find(([outer])=>insideRing(hole[0][0],hole[0][1],outer));if(owner)owner.push(hole)}return outers}
