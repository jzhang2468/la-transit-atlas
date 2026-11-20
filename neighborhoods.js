'use strict';

const $ = (id) => document.getElementById(id);
const html = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const metersPerDegree = 111195;

function clockTime(minutes) {
  const hour = Math.floor(minutes / 60);
  return (hour % 12 || 12) + ':' + String(minutes % 60).padStart(2, '0') + (hour % 24 < 12 ? ' AM' : ' PM');
}

async function getData() {
  if (location.protocol === 'file:') {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './data/neighborhoods-standalone.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Missing local comparison dataset'));
      document.head.appendChild(script);
    });
    return window.NEIGHBORHOOD_DATA;
  }
  const response = await fetch('./data/neighborhoods.json');
  if (!response.ok) throw new Error('Could not load comparison dataset');
  return response.json();
}

function eachPart(geometry, visit) {
  switch (geometry.type) {
    case 'LineString': visit(geometry.coordinates, false); break;
    case 'MultiLineString': geometry.coordinates.forEach((line) => visit(line, false)); break;
    case 'Polygon': geometry.coordinates.forEach((ring) => visit(ring, true)); break;
    case 'MultiPolygon': geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => visit(ring, true))); break;
    case 'GeometryCollection': geometry.geometries.forEach((part) => eachPart(part, visit)); break;
  }
}

function metricOffset(coordinates, center) {
  const longitudeFactor = Math.cos(center[1] * Math.PI / 180);
  return [(coordinates[0] - center[0]) * longitudeFactor * metersPerDegree, (center[1] - coordinates[1]) * metersPerDegree];
}

function makeMap(caseData) {
  const figure = html('figure', 'map-field');
  const canvas = html('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', caseData.name + ', census tract ' + caseData.tract + ', with the sampled Metro ' + caseData.route.shortName + ' route and boarding stop at ' + caseData.stop.name + '.');
  const north = html('div', 'north', 'N');
  north.setAttribute('aria-hidden', 'true');
  const scale = html('div', 'scale');
  const scaleText = html('span');
  const scaleBar = html('span', 'scale-line');
  scale.append(scaleText, scaleBar);
  figure.append(canvas, north, scale);
  return {caseData, figure, canvas, scaleBar, scaleText};
}

function measureTract(caseData, aspect) {
  let halfWidth = 0, halfHeight = 0;
  const include = (position) => {
    const [x, y] = metricOffset(position, caseData.center);
    halfWidth = Math.max(halfWidth, Math.abs(x));
    halfHeight = Math.max(halfHeight, Math.abs(y));
  };
  eachPart(caseData.polygon, (part) => part.forEach(include));
  include(caseData.stop.coordinates);
  return Math.max(halfWidth, halfHeight * aspect) * 2.15;
}

function paintMap(panel, widthMeters, view) {
  const {caseData, canvas, scaleBar, scaleText} = panel;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#e7e7e5';
  ctx.fillRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const origin = view === 'stop' ? caseData.stop.coordinates : caseData.center;
  const factor = width / widthMeters;
  const project = (coordinate) => {
    const [x, y] = metricOffset(coordinate, origin);
    return [width / 2 + x * factor, height / 2 + y * factor];
  };
  function drawGeometry(geometry, color, stroke, lineWidth) {
    ctx.beginPath();
    eachPart(geometry, (part, closed) => {
      part.forEach((position, i) => {
        const [x, y] = project(position);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (closed) ctx.closePath();
    });
    if (color) { ctx.fillStyle = color; ctx.fill('evenodd'); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }
  const background = caseData.context.features;
  for (const feature of background) {
    const kind = feature.properties.kind;
    if (kind === 'water' || kind === 'park') drawGeometry(feature.geometry, kind === 'water' ? '#dcdedf' : '#dedfdc');
  }
  drawGeometry(caseData.polygon, '#c5c5c266');
  const roads = background.filter((feature) => ['highway','road','street','arterial'].includes(feature.properties.kind));
  for (const feature of roads) {
    const major = ['highway','arterial'].includes(feature.properties.kind);
    drawGeometry(feature.geometry, null, major ? '#fdfdfb' : '#f7f7f5', major ? 3.1 : 1.45);
  }
  drawGeometry(caseData.polygon, null, '#525252', 1.25);
  caseData.lines.features.forEach((feature) => drawGeometry(feature.geometry, null, '#f3f3ef', 4.1));
  ctx.setLineDash([5,4]);
  caseData.lines.features.forEach((feature) => drawGeometry(feature.geometry, null, '#161616', 2));
  ctx.setLineDash([]);
  for (const stop of caseData.stops.features) {
    if (String(stop.properties.id) === String(caseData.stop.id)) continue;
    const [x,y] = project(stop.geometry.coordinates);
    if (x<0 || y<0 || x>width || y>height) continue;
    ctx.beginPath(); ctx.arc(x,y,2.2,0,Math.PI*2);
    ctx.fillStyle='#777'; ctx.fill();
    ctx.lineWidth=.6; ctx.strokeStyle='#fff'; ctx.stroke();
  }
  const [sx, sy] = project(caseData.stop.coordinates);
  const stopName = caseData.stop.name.replace(/\s*\/\s*/g, ' / ');
  ctx.font = '600 11px Inter, Arial, sans-serif';
  const nameWidth = Math.min(ctx.measureText(stopName).width + 14, width - 24);
  const boxX = Math.max(5, Math.min(sx + 13 + nameWidth < width - 15 ? sx + 13 : sx - nameWidth - 13, width - nameWidth - 5));
  const boxY = Math.max(8, Math.min(sy - 23, height - 31));
  const occupied = [[boxX - 4, boxY - 4, nameWidth + 8, 30], [0,height - 39,95,39], [width - 35,0,35,42]];
  // Favor locally long named segments and place at most one label per street.
  const candidates = [];
  for (const feature of roads) {
    const name = feature.properties.name;
    if (!name) continue;
    eachPart(feature.geometry, (line) => {
      for (let i=1; i<line.length; i++) {
        const a = project(line[i-1]), b = project(line[i]);
        const x = (a[0]+b[0])/2, y = (a[1]+b[1])/2;
        if (x<35 || x>width-35 || y<17 || y>height-15) continue;
        const length = Math.hypot(b[0]-a[0], b[1]-a[1]);
        if (length>21) candidates.push({name,x,y,length,angle:Math.atan2(b[1]-a[1],b[0]-a[0])});
      }
    });
  }
  candidates.sort((a,b) => b.length-a.length);
  const names = new Set();
  ctx.font = '10px Inter, Arial, sans-serif';
  for (const candidate of candidates) {
    const {name,x,y} = candidate;
    if (names.has(name) || names.size >= Math.round(width/65)) continue;
    let angle = candidate.angle;
    if (angle > Math.PI/2) angle -= Math.PI;
    if (angle < -Math.PI/2) angle += Math.PI;
    const size = ctx.measureText(name).width + 7;
    const w = Math.abs(Math.cos(angle))*size+15, h = Math.abs(Math.sin(angle))*size+15;
    if (x-w/2<4 || x+w/2>width-5 || y-h/2<5 || y+h/2>height-5) continue;
    if (occupied.some(([bx,by,bw,bh]) => x+w/2 > bx && x-w/2 < bx+bw && y+h/2 > by && y-h/2 < by+bh)) continue;
    occupied.push([x-w/2-4,y-h/2-4,w+8,h+8]); names.add(name);
    ctx.save(); ctx.translate(x,y); ctx.rotate(angle); ctx.textAlign='center';
    ctx.strokeStyle='#edeeeb'; ctx.lineWidth=3; ctx.strokeText(name,0,-3);
    ctx.fillStyle='#575956'; ctx.fillText(name,0,-3); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(sx,sy,8,0,Math.PI*2); ctx.fillStyle='#f9f9f7'; ctx.fill();
  ctx.strokeStyle = '#232323'; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.arc(sx,sy,4.5,0,Math.PI*2); ctx.fillStyle='#dd1237'; ctx.fill();
  ctx.fillStyle='#f8f8f7ed'; ctx.fillRect(boxX,boxY,nameWidth,21);
  ctx.fillStyle='#151515'; ctx.font='600 11px Inter, Arial, sans-serif'; ctx.textAlign='left';
  ctx.fillText(stopName,boxX+7,boxY+14,nameWidth-14);
  const barMeters = [25,50,100,200,250,500,1000,2000].filter((m) => m*factor<=width*.18).pop() || 25;
  scaleBar.style.width = (barMeters * factor) + 'px';
  scaleText.textContent = barMeters < 1000 ? barMeters+' m' : barMeters/1000+' km';
}

function caseCard(caseData) {
  const card = html('article');
  const header = html('header', 'case-head');
  const name = html('h2', '', caseData.name);
  header.append(name, html('span', 'tract-id', 'Census tract ' + caseData.tract));
  const map = makeMap(caseData);
  const caption = html('p', 'map-caption');
  caption.append(html('span', 'route-tag', caseData.route.shortName+' '+caseData.route.direction.toLowerCase()), html('strong', '', caseData.stop.name));
  if (caseData.route.headsign) caption.append(document.createTextNode(' · Toward ' + caseData.route.headsign));
  const facts = html('dl', 'facts');
  const fact = (label, value) => {
    const group = html('div');
    group.append(html('dt', '', label), html('dd', '', value.toFixed(1) + '%'));
    return group;
  };
  facts.append(fact('Rent burdened',caseData.burden), fact('Renters without a vehicle',caseData.zeroVehicle));
  card.append(header, map.figure, caption, facts);
  $('cases').appendChild(card);
  return map;
}

function timetable(data) {
  const [start,end] = data.window;
  const percent = (minute) => ((minute-start)/(end-start)*100)+'%';
  const grid = [];
  for (let minute=start; minute<=end; minute+=30) grid.push(minute);
  const axis = html('div','timeline-axis');
  const labels = html('div');
  grid.forEach((time) => { const label=html('span','tick-label',clockTime(time)); label.style.left=percent(time); labels.appendChild(label); });
  axis.appendChild(labels); $('timetable').appendChild(axis);
  const lanes = data.cases.map((item) => {
    const row=html('div','timeline-row'), label=html('div');
    label.append(html('p','lane-title',item.name+' · '+item.route.shortName),html('p','lane-count',item.departures.length+' departures'));
    const strip=html('div','strip');
    strip.setAttribute('aria-hidden','true');
    grid.forEach((time) => { const line=html('i','grid-line'); line.style.left=percent(time); strip.appendChild(line); });
    const ticks = item.departures.map((time) => {
      const tick=html('i','departure'); tick.title=clockTime(time); tick.style.left=percent(time); strip.appendChild(tick); return tick;
    });
    const cursor=html('i','cursor'); strip.appendChild(cursor);
    const readout=html('p','arrival-readout');
    row.append(label,strip,readout); $('timetable').appendChild(row);
    const times=html('p');
    times.append(html('strong','',item.name+' · '+item.route.shortName+'  '),document.createTextNode(item.departures.map(clockTime).join(', ')));
    $('exact-times').appendChild(times);
    return {item,ticks,cursor,readout,strip};
  });
  const slider=$('arrival');
  slider.min=start; slider.max=end-1;
  slider.value=Math.min(start+60,end-1);
  function update(announce) {
    const minute=Number(slider.value), phrase=clockTime(minute);
    $('arrival-time').value=phrase; slider.setAttribute('aria-valuetext',phrase+' Pacific');
    const status=lanes.map(({item,ticks,cursor,readout})=>{
      const next=item.departures.findIndex((time)=>time>=minute);
      ticks.forEach((tick,index)=>tick.classList.toggle('next',index===next));
      cursor.style.left=percent(minute);
      const remaining=next<0 ? 'No later trip in window' : item.departures[next]===minute ? 'Departs now' : (item.departures[next]-minute)+' min · '+clockTime(item.departures[next]);
      readout.textContent=remaining;
      return item.name+', '+remaining;
    });
    if(announce) $('arrival-announcement').textContent=status.join('. ');
  }
  lanes.forEach(({strip}) => strip.addEventListener('click',(event)=>{
    const box=strip.getBoundingClientRect();
    slider.value=Math.min(end-1,Math.max(start,Math.round(start+(end-start)*(event.clientX-box.left)/box.width)));
    update(true);
  }));
  slider.addEventListener('input',()=>update(false));
  slider.addEventListener('change',()=>update(true));
  update(false);
}

function showComparison(data) {
  const [first,second] = data.cases;
  const intro=$('intro-text');
  const burden = Math.round((first.burden + second.burden) / 2);
  intro.replaceChildren(
    document.createTextNode('In both tracts, about '+burden+'% of renters with a reported rent-to-income ratio spend at least 30% of their income on rent. From 7 to 9 PM, Metro schedules '),
    html('strong', '', first.departureCount+' '+first.route.direction.toLowerCase()+' departures'),
    document.createTextNode(' at the '+first.name+' stop and '),
    html('strong', '', second.departureCount+' '+second.route.direction.toLowerCase()+' departures'),
    document.createTextNode(' at the '+second.name+' stop.')
  );
  $('load-status').hidden = true;
  $('atlas-content').hidden = false;
  const panels=data.cases.map(caseCard);
  let view='tract';
  function drawMaps() {
    const {canvas}=panels[0];
    const aspect=canvas.clientWidth/canvas.clientHeight;
    const fullSpan=Math.max(...data.cases.map((item)=>measureTract(item,aspect)),1750);
    const width=view==='tract' ? fullSpan : Math.min(fullSpan*.55,1250);
    panels.forEach((panel)=>paintMap(panel,width,view));
  }
  document.querySelectorAll('[data-view]').forEach((button)=>button.addEventListener('click',()=>{
    view=button.dataset.view;
    document.querySelectorAll('[data-view]').forEach((other)=>other.setAttribute('aria-pressed',String(other===button)));
    drawMaps();
  }));
  new ResizeObserver(drawMaps).observe(panels[0].figure);
  drawMaps();
  if(document.fonts) document.fonts.ready.then(drawMaps);
  const date = new Date(data.date+'T12:00:00');
  const serviceDate = date.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  $('study-dates').textContent='City of Los Angeles · 2019–2023 renter estimates and Metro schedules for '+serviceDate;
  $('service-date').textContent=serviceDate+' · Pacific time';
  timetable(data);
  for(const note of data.method) $('method-notes').appendChild(html('p','',note));
  for(const source of data.sources) {
    const item=html('li');const link=html('a','',source.name); link.href=source.url; item.appendChild(link);$('source-links').appendChild(item);
  }
  document.querySelector('nav a[href="#methods"]').addEventListener('click',()=>{$('methods').open=true;});
  if(location.hash==='#methods') $('methods').open=true;
}

getData().then(showComparison).catch((error)=>{
  $('load-status').hidden=false;
  $('load-status').textContent='The comparison data could not be loaded. Refresh this page or return to the atlas overview.';
  console.error(error);
});
