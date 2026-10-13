export function SolarMark() {
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 3 42 10v12c0 11.2-7.4 19.1-18 23C13.4 41.1 6 33.2 6 22V10L24 3Z" fill="#0b1728" stroke="currentColor" strokeWidth="2.4"/><circle cx="33.5" cy="14" r="5" fill="#ffc857"/><path d="m12.5 23 18-5 5 14-18 5-5-14Z" fill="#173f5c" stroke="#2de2b1" strokeWidth="1.5"/><path d="m15 27 18-5M16.5 31.5l18-5M20 21l4 14M26 19.5l4 14" stroke="#4da3ff" strokeWidth="1" opacity=".9"/><path d="m17 39 4 3 10-5" fill="none" stroke="#2de2b1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function PvHeroVisual() {
  return <div className="pv-hero-visual" aria-label="Schemat domu z instalacją fotowoltaiczną">
    <svg viewBox="0 0 620 430" role="img">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#193f34"/><stop offset="1" stopColor="#0b1d19"/></linearGradient><linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#22715c"/><stop offset="1" stopColor="#0c2c27"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="8"/></filter></defs>
      <rect x="1" y="1" width="618" height="428" rx="28" fill="url(#sky)" stroke="#28483f"/>
      <circle cx="500" cy="84" r="38" fill="#ffc45c" opacity=".18" filter="url(#glow)"/><circle cx="500" cy="84" r="22" fill="#ffc45c"/>
      {[0,1,2,3,4,5,6,7].map(i=><line key={i} x1="500" y1="84" x2={500+Math.cos(i*Math.PI/4)*48} y2={84+Math.sin(i*Math.PI/4)*48} stroke="#ffc45c" strokeWidth="3" strokeLinecap="round" opacity=".65"/>)}
      <path d="M105 280 285 151l185 129v103H105V280Z" fill="#102923" stroke="#31554b" strokeWidth="3"/><path d="m83 287 202-145 207 145" fill="none" stroke="#8caaa2" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/>
      <g transform="translate(180 183) skewX(-34)"><rect width="185" height="90" rx="4" fill="url(#panel)" stroke="#69e6a6" strokeWidth="2"/>{[1,2,3].map(i=><line key={`v${i}`} x1={i*46.25} y1="0" x2={i*46.25} y2="90" stroke="#78b9a5" opacity=".65"/>)}{[1,2].map(i=><line key={`h${i}`} x1="0" y1={i*30} x2="185" y2={i*30} stroke="#78b9a5" opacity=".65"/>)}</g>
      <rect x="355" y="300" width="70" height="83" rx="5" fill="#0a1714" stroke="#31554b"/><circle cx="390" cy="323" r="6" fill="#69e6a6"/><path d="M376 348h28M376 359h19" stroke="#87a49c" strokeWidth="3" strokeLinecap="round"/>
      <path d="M320 267c70 0 24 56 70 56" fill="none" stroke="#69e6a6" strokeWidth="3" strokeDasharray="7 7" className="energy-path"/>
      <path d="M425 342c63 0 54-90 98-90" fill="none" stroke="#ffc45c" strokeWidth="3" strokeDasharray="7 7" className="energy-path"/>
      <g transform="translate(467 219)"><rect width="105" height="69" rx="12" fill="#102923" stroke="#31554b"/><path d="M19 49V36l13-10 12 8 17-19 24 34" fill="none" stroke="#69e6a6" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="85" cy="18" r="5" fill="#ffc45c"/></g>
      <g transform="translate(55 45)"><rect width="224" height="72" rx="14" fill="#091815" stroke="#31554b"/><circle cx="27" cy="27" r="7" fill="#69e6a6"/><text x="45" y="31" fill="#f1f7f4" fontSize="16" fontWeight="700">Produkcja aktywna</text><text x="45" y="52" fill="#87a49c" fontSize="11.5" letterSpacing=".15">pogoda · model · monitoring</text></g>
    </svg>
    <span className="visual-chip chip-sun">Nasłonecznienie</span><span className="visual-chip chip-ai">Prognoza AI</span>
  </div>;
}

type IconName="weather"|"model"|"energy"|"alert";
export function FlowIcon({name}:{name:IconName}){
  if(name==="weather")return <svg viewBox="0 0 32 32"><circle cx="12" cy="12" r="6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2"/><path d="M12 25h14c4 0 4-7 0-7-1-6-10-6-11 0"/></svg>;
  if(name==="model")return <svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" rx="5"/><path d="M11 1v4M21 1v4M11 27v4M21 27v4M1 11h4M27 11h4M1 21h4M27 21h4M11 20l4-5 3 3 4-6"/></svg>;
  if(name==="energy")return <svg viewBox="0 0 32 32"><path d="M18 2 8 18h8l-2 12 10-17h-8l2-11Z"/></svg>;
  return <svg viewBox="0 0 32 32"><path d="M16 3 29 27H3L16 3Z"/><path d="M16 11v8M16 23v1"/></svg>;
}
