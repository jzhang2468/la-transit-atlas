'use strict';

const byId = (id) => document.getElementById(id);
const format = (value) => new Intl.NumberFormat('en-US').format(value);
const rateText = (value) => value == null ? 'Unavailable' : value.toFixed(1) + '%';
const categories = {
  both: {label: 'High on both measures', color: '#e72e4f'},
  burden: {label: 'High rent burden only', color: '#e7aaa6'},
  vehicle: {label: 'High share of renters without a vehicle only', color: '#96adb4'},
  neither: {label: 'Lower on both measures', color: '#e5e5e1'},
  'no-data': {label: 'Missing estimate', color: '#ffffff'}
};
const regions = {
  city: [[-118.69, 33.695], [-118.145, 34.347]],
  valley: [[-118.666, 34.115], [-118.265, 34.333]],
  central: [[-118.399, 33.963], [-118.157, 34.118]],
  harbor: [[-118.337, 33.704], [-118.214, 33.825]]
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = path;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load ' + path));
    document.head.append(script);
  });
}

async function loadLayers() {
  if (location.protocol === 'file:') {
    await Promise.all([loadScript('./data/renter-vehicles-standalone.js'), loadScript('./data/standalone.js')]);
    return [window.RENTER_VEHICLES_DATA, window.ATLAS_DATA.context, window.ATLAS_DATA.city];
  }
  return Promise.all(['renter-vehicles.json','context.geojson','city.geojson'].map(async name => {
    const response = await fetch('./data/' + name);
    if (!response.ok) throw new Error('Could not load ' + name);
    return response.json();
  }));
}

function showStudy(meta) {
  const summary = byId('summary-text');
  summary.replaceChildren(element('strong',format(meta.counts.both) + ' of ' + format(meta.validBoth) + ' tracts'),
    document.createTextNode(' with both estimates meet the high thresholds.'));
  if (meta.lowerRail) {
    summary.append(document.createTextNode(' Among the ' + format(meta.lowerRail.total) +
      ' high-burden tracts with lower rail coverage in the original atlas map, '),
      element('strong',String(meta.lowerRail.both)),document.createTextNode(' also have a high share of renters without a vehicle.'));
  }
  document.querySelectorAll('[data-category]').forEach(button => {
    const key = button.dataset.category;
    button.setAttribute('aria-label',categories[key].label + ', ' + format(meta.counts[key]) + ' tracts');
    const count = button.querySelector('strong');
    if (count) count.textContent = format(meta.counts[key]);
  });
  byId('missing-count').textContent = '· ' + meta.counts['no-data'] + ' tracts';
  byId('thresholds').textContent = 'High begins at approximately ' + meta.burdenThreshold.toFixed(2) +
    '% of renters spending at least 30% of income on gross rent, and ' + meta.vehicleThreshold.toFixed(2) + '% of renters without a vehicle.';
  for (const note of meta.methods) byId('method-notes').append(element('p',note));
  for (const {name,url} of meta.sources) {
    const link = element('a',name); link.href = url;
    const item = element('li'); item.append(link); byId('source-list').append(item);
  }
}

function hatchImage() {
  const tile = element('canvas');
  tile.width = tile.height = 10;
  const ctx = tile.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,10,10);
  ctx.strokeStyle = '#999994'; ctx.lineWidth = 1.25; ctx.beginPath();
  for (const offset of [-10,0,10]) { ctx.moveTo(offset,10); ctx.lineTo(offset+10,0); }
  ctx.stroke();
  return ctx.getImageData(0,0,10,10);
}

function addThematicLayers(map) {
  function add(id,type,source,paint,filter) {
    map.addLayer({id,type,source,paint,...(filter ? {filter} : {})});
  }
  const context = (kind) => ['==',['get','kind'],kind];
  add('land','fill','context',{'fill-color':'#f1f1ee'},context('land'));
  add('park','fill','context',{'fill-color':'#e7eae3'},context('park'));
  add('coast','line','context',{'line-color':'#c2c6c5','line-width':.65},context('coast'));
  const palette = ['match',['get','category'],...Object.entries(categories).flatMap(([name,category])=>[name,category.color]),'#fff'];
  add('renter-fill','fill','renters',{'fill-color':palette,'fill-opacity':.95});
  map.addImage('missing-hatch',hatchImage(),{pixelRatio:2});
  add('renter-missing','fill','renters',{'fill-pattern':'missing-hatch'},contextMissing());
  add('renter-border','line','renters',{'line-color':'#fbfbf8',
    'line-width':['interpolate',['linear'],['zoom'],8,.24,10,.5,13,.85],'line-opacity':.85});
  add('water','fill','context',{'fill-color':'#e3e6e7','fill-opacity':.76},context('water'));
  add('streets','line','context',{'line-color':'#fff','line-opacity':.38,
    'line-width':['interpolate',['linear'],['zoom'],8,.35,12,.8,15,1.4]},context('road'));
  add('highways','line','context',{'line-color':'#a0a29d','line-opacity':.46,
    'line-width':['interpolate',['linear'],['zoom'],8,.55,13,1.35]},context('highway'));
  add('city-boundary','line','city',{'line-color':'#454643','line-opacity':.83,'line-width':.86});
  add('picked-halo','line','renters',{'line-color':'#fff','line-width':4.8},['==',['get','geoid'],'']);
  add('picked-line','line','renters',{'line-color':'#151515','line-width':2.25},['==',['get','geoid'],'']);
}

function contextMissing() { return ['==',['get','category'],'no-data']; }

function installPlaceLabels(map, contextData) {
  const priority = ['Van Nuys','Hollywood','Downtown Los Angeles','San Pedro','Santa Monica','Pasadena',
    'Long Beach','Koreatown','Inglewood','Wilmington','Westwood','Burbank','Glendale','Compton','Boyle Heights','Culver City','Torrance'];
  const places = new Map(contextData.features.filter(feature=>feature.properties.kind==='place')
    .map(feature=>[feature.properties.name,feature.geometry.coordinates]));
  const used = [];
  const entries = priority.flatMap((name,index) => {
    if (!places.has(name)) return [];
    return [{name,coordinates:places.get(name),minZoom:index<7 ? 7 : 10.1}];
  });
  entries.push({name:'Pacific Ocean',coordinates:[-118.52,33.844],minZoom:7});
  for (const entry of entries) {
    const label = element('span',entry.name === 'Downtown Los Angeles' ? 'Downtown LA' : entry.name,
      entry.name==='Pacific Ocean'?'place-name ocean':'place-name');
    new maplibregl.Marker({element:label}).setLngLat(entry.coordinates).addTo(map);
    used.push({...entry,label});
  }
  function layout() {
    const occupied = [];
    for (const {label,coordinates,minZoom} of used) {
      const p = map.project(coordinates), width=label.textContent.length*6.1+9;
      const rect = {x:p.x-width/2, y:p.y-8, r:p.x+width/2,b:p.y+8};
      const show = map.getZoom()>=minZoom && !occupied.some(previous =>
        rect.x<previous.r && rect.r>previous.x && rect.y<previous.b && rect.b>previous.y);
      label.hidden=!show;
      if(show) occupied.push(rect);
    }
  }
  map.on('move',layout); layout();
}

function featureBounds(feature) {
  const bounds = new maplibregl.LngLatBounds();
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  polygons.forEach(poly=>poly[0].forEach(point=>bounds.extend(point)));
  return bounds;
}

function installExplorer(map, data) {
  let filter = null, popup = null;
  const selector = byId('tract-picker'), byGeoid = new Map(data.features.map(feature=>[feature.properties.geoid,feature]));
  const sorted = [...data.features].sort((a,b)=>a.properties.geoid.localeCompare(b.properties.geoid));
  const exampleId = '06037211802';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const groups = document.querySelectorAll('[data-category]');

  function pickExtent(region, animate = true) {
    map.fitBounds(regions[region],{padding:18,duration:animate && !reducedMotion ? 460:0});
    for(const button of document.querySelectorAll('[data-region]')) button.setAttribute('aria-pressed',String(button.dataset.region===region));
  }
  function customExtent() { document.querySelectorAll('[data-region]').forEach(button=>button.setAttribute('aria-pressed','false')); }
  function renderOptions() {
    const options = document.createDocumentFragment();
    options.append(new Option('Select a tract on the map or list',''));
    for (const {properties:{tract,geoid,category}} of sorted) {
      if(!filter || filter===category) options.append(new Option('Tract '+tract,geoid));
    }
    selector.replaceChildren(options);
  }
  function clearSelected() {
    popup?.remove(); popup=null; selector.value='';
    for(const layer of ['picked-line','picked-halo']) map.setFilter(layer,['==',['get','geoid'],'']);
    byId('inspect').replaceChildren();
    const example=byGeoid.get(exampleId);
    if(example && (!filter || example.properties.category===filter)) {
      const button=element('button','Explore the Koreatown example','text-button');
      button.type='button';button.addEventListener('click',()=>select(example,true));
      byId('inspect').append(button);
    }
  }
  function setFilter(category) {
    filter = filter===category ? null : category;
    const active = filter ? ['==',['get','category'],filter] : null;
    map.setFilter('renter-fill',active);
    map.setFilter('renter-border',active);
    map.setFilter('renter-missing',filter && filter!=='no-data' ? ['==',['get','category'],''] : contextMissing());
    groups.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.category===filter)));
    byId('all').disabled=!filter;
    byId('filter-status').textContent=filter ? 'Showing '+format(data.meta.counts[filter])+' tracts. '+categories[filter].label+'.' : 'Showing all census tracts.';
    renderOptions();clearSelected();
  }
  function select(feature, zoom, point) {
    const p = feature.properties;
    selector.value=p.geoid;
    const category=element('p',null,'inspected-type'), swatch=element('i',null,'swatch');
    swatch.style.backgroundColor=categories[p.category].color;
    category.append(swatch,document.createTextNode(categories[p.category].label));
    const facts = element('dl',null,'detail-numbers');
    for (const [title,value] of [['Rent-burdened renters',p.burden],['Renters without a vehicle',p.zeroVehicle]]) {
      const row=element('div');row.append(element('dt',title),element('dd',rateText(value)));facts.append(row);
    }
    byId('inspect').replaceChildren(category,facts);
    for (const layer of ['picked-halo','picked-line']) map.setFilter(layer,['==',['get','geoid'],p.geoid]);
    const bounds=featureBounds(feature);
    if(zoom) {customExtent();map.fitBounds(bounds,{maxZoom:13,padding:56,duration:reducedMotion?0:420});}
    const content=element('div');
    content.append(element('strong','Tract '+p.tract),element('p','Rent burden · '+rateText(p.burden)),
      element('p','No vehicle · '+rateText(p.zeroVehicle)));
    popup?.remove();
    popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,className:'tract-popup',offset:7,maxWidth:'220px',focusAfterOpen:false})
      .setLngLat(point||bounds.getCenter()).setDOMContent(content).addTo(map);
  }
  renderOptions();clearSelected();
  for (const button of groups) button.addEventListener('click',()=>setFilter(button.dataset.category));
  byId('all').addEventListener('click',()=>setFilter(null));
  selector.addEventListener('change',()=>{
    const feature=byGeoid.get(selector.value);if(feature) select(feature,true);else clearSelected();
  });
  map.on('click',event=>{
    const hit=map.queryRenderedFeatures(event.point,{layers:['renter-fill']})[0];
    const feature=hit&&byGeoid.get(hit.properties.geoid);
    if(feature) select(feature,false,event.lngLat); else clearSelected();
  });
  map.on('mouseenter','renter-fill',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','renter-fill',()=>{map.getCanvas().style.cursor='';});
  map.on('movestart',event=>{if(event.originalEvent) customExtent();});
  document.querySelectorAll('[data-region]').forEach(button=>button.addEventListener('click',()=>{
    clearSelected();pickExtent(button.dataset.region);
  }));
  map.getContainer().addEventListener('keydown',event=>{if(event.key==='Escape') clearSelected();});
  pickExtent('city',false);
}

async function start() {
  const [tractData,contextData,cityData] = await loadLayers();
  showStudy(tractData.meta);
  document.querySelector('nav a[href="#methods"]').addEventListener('click',()=>{byId('methods').open=true;});
  if(location.hash==='#methods') byId('methods').open=true;
  const map = new maplibregl.Map({
    container:'city-map',style:{version:8,sources:{
      context:{type:'geojson',data:contextData},
      city:{type:'geojson',data:cityData},
      renters:{type:'geojson',data:tractData,promoteId:'geoid'}
    },layers:[{id:'ocean',type:'background',paint:{'background-color':'#dfe2e3'}}]},
    bounds:regions.city,fitBoundsOptions:{padding:18},maxBounds:[[-119.35,33.24],[-117.45,34.79]],
    minZoom:7,maxZoom:15,dragRotate:false,pitchWithRotate:false,renderWorldCopies:false,attributionControl:false
  });
  map.touchZoomRotate.disableRotation();
  const northArrow = document.querySelector('.north');
  map.on('rotate', () => { northArrow.style.transform = 'rotate(' + (-map.getBearing()) + 'deg)'; });
  map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-left');
  map.addControl(new maplibregl.ScaleControl({unit:'metric',maxWidth:90}),'bottom-left');
  map.once('load',()=>{
    try {
      addThematicLayers(map);
      installPlaceLabels(map,contextData);
      installExplorer(map,tractData);
      byId('map-message').hidden=true;
    } catch(error) { fail(error); }
  });
}
function fail(error) {
  console.error(error);
  const message=byId('map-message');message.hidden=false;
  const link=element('a','Open the map PDF');link.href='./renter-vehicles.pdf';
  message.replaceChildren(document.createTextNode('The interactive map could not load. '),link);
}
start().catch(fail);
