"use strict";

const $ = (selector) => document.querySelector(selector);
const blank = () => ({type: "FeatureCollection", features: []});
const number = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
const format = (value) => number.format(value);
const money = (value) => value == null ? "—" : value === 3501 ? "$3,500+" : dollars.format(value);
const percent = (value, digits = 1) => value == null ? "—" : `${value.toFixed(digits)}%`;
const esc = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const classes = [
  {id: "lower-rent-higher-burden", name: "Lower rent, higher burden", color: "#b97266", text: "#161b20"},
  {id: "higher-rent-higher-burden", name: "Higher rent, higher burden", color: "#f3aa92", text: "#181c22"},
  {id: "lower-rent-lower-burden", name: "Lower rent, lower burden", color: "#435d69", text: "#f4f1ea"},
  {id: "higher-rent-lower-burden", name: "Higher rent, lower burden", color: "#87bdc4", text: "#17232b"},
  {id: "no-data", name: "Unavailable housing data", color: "#293844", text: "#e5ebed"}
];

const housingPalette = ["match", ["get", "quadrant"],
  ...classes.flatMap(({id, color}) => [id, color]), "#293844"];
const railPalette = ["case", ["!", ["get", "railNear"]], "#384957",
  ["==", ["get", "quadrant"], "no-data"], "#57636a",
  ["in", ["get", "quadrant"], ["literal", classes.slice(0, 2).map(({id}) => id)]], "#e1a188",
  "#6caaad"];

const stories = {
  housing: {title: "Median rent × renter cost burden", subtitle: "ACS 2019–2023",
    instruction: "Filter by color or select a tract to see its numbers."},
  rail: {title: "Eight hundred meters from Metro rail", subtitle: "Metro rail · November 2026",
    instruction: "Select a tract or station to inspect rail proximity."},
  commute: {title: "Home to workplace", subtitle: "Census LODES primary jobs · 2024",
    instruction: "Select a home tract. Line widths scale with the number of jobs."}
};

const namedTracts = new Map([
  ["06037234600", "Hyde Park"], ["06037269909", "Palms"],
  ["06037211802", "Koreatown"], ["06037122122", "Sun Valley"],
  ["06037207400", "Civic Center"], ["06037267901", "Century City"],
  ["06037310501", "Burbank"], ["06037980028", "LAX"]
]);
const examples = {
  housing: ["06037234600", "06037269909"],
  rail: ["06037211802", "06037122122"]
};
const state = {
  mode: "housing", selected: null, hovered: null, station: null, destination: null,
  category: null, nearOnly: false, buffers: true, pair: false, dock: null, labels: []
};

let map;
let data;
let tracts;
let currentFlows = [];
let flowFrame = 0;

async function loadData() {
  if (location.protocol === "file:") {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./data/standalone.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
    if (!window.ATLAS_DATA) throw new Error("Missing standalone dataset");
    return window.ATLAS_DATA;
  }
  const paths = {context: "context.geojson", tracts: "tracts.geojson", stations: "stations.geojson",
    rail: "rail.geojson", buffers: "buffers.geojson", rings: "rings.geojson", summary: "summary.json", commute: "commute.json"};
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => {
    const response = await fetch(`./data/${path}`);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return [name, await response.json()];
  })));
}

function addLayers() {
  const context = (kind) => ["==", ["get", "kind"], kind];
  const add = (id, type, source, paint, options = {}) => map.addLayer({id, type, source, paint, ...options});
  const filterId = (id) => ["==", ["get", "geoid"], id || ""];

  add("land", "fill", "context", {"fill-color": "#253641"}, {filter: context("land")});
  add("parks", "fill", "context", {"fill-color": "#34433e", "fill-opacity": .72}, {filter: context("park")});
  add("tract-color", "fill", "tracts", {"fill-color": housingPalette, "fill-opacity": .86});
  add("context-water", "fill", "context", {"fill-color": "#172d3b"}, {filter: context("water")});
  add("tract-borders", "line", "tracts", {"line-color": "#151e28", "line-opacity": .37,
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, .28, 10, .48, 14, .85]});
  add("streets", "line", "context", {"line-color": "#b5c8ce", "line-opacity": .32,
    "line-width": ["interpolate", ["linear"], ["zoom"], 9, .36, 12, .8, 15, 2.2]},
  {filter: context("road"), minzoom: 8.8});
  add("highway-edge", "line", "context", {"line-color": "#25323f", "line-opacity": .31,
    "line-width": ["interpolate", ["linear"], ["zoom"], 7, .6, 12, 1.9, 15, 5]},
  {filter: context("highway")});
  add("highway", "line", "context", {"line-color": "#bfc8c8", "line-opacity": .52,
    "line-width": ["interpolate", ["linear"], ["zoom"], 7, .2, 12, 1.15, 15, 3.6]},
  {filter: context("highway")});
  add("coast", "line", "context", {"line-color": "#52707e", "line-width": .55}, {filter: context("coast")});
  add("city-border", "line", "context", {"line-color": "#a7b8c3", "line-width": .95,
    "line-opacity": .67, "line-dasharray": [5, 2]}, {filter: context("city")});
  add("county-border", "line", "context", {"line-color": "#748e9e", "line-width": .8,
    "line-opacity": .52}, {filter: context("county")});

  add("station-areas", "fill", "buffers", {"fill-color": "#89c9cd", "fill-opacity": .13});
  add("station-rings", "line", "rings", {"line-color": "#a3dfdc", "line-opacity": .58, "line-width": .8,
    "line-dasharray": [1, 1.5]});
  add("rail-halo", "line", "rail", {"line-color": "#111a22", "line-opacity": .72,
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.3, 13, 4]});
  add("rail-line", "line", "rail", {"line-color": "#c3e6e3", "line-dasharray": [2, 1.6],
    "line-opacity": .89, "line-width": ["interpolate", ["linear"], ["zoom"], 8, .8, 13, 2.3]});
  add("rail-station", "circle", "stations", {"circle-color": "#192932", "circle-stroke-color": "#c3e6e3",
    "circle-stroke-width": .85, "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1.8, 13, 4.1]});
  add("station-focus", "circle", "stations", {"circle-color": "#f3aa92", "circle-stroke-color": "#1a2833",
    "circle-stroke-width": 2, "circle-radius": 7}, {filter: ["==", ["id"], ""]});
  add("pair-outline", "line", "tracts", {"line-color": "#121b25", "line-width": 4.5},
    {filter: ["in", ["get", "geoid"], ["literal", []]]});
  add("pair-ink", "line", "tracts", {"line-color": "#f3aa92", "line-width": 2, "line-dasharray": [2, 1]},
    {filter: ["in", ["get", "geoid"], ["literal", []]]});
  add("selected-fill", "fill", "tracts", {"fill-color": "#f3aa92", "fill-opacity": .2}, {filter: filterId()});
  add("selected-halo", "line", "tracts", {"line-color": "#1a2833", "line-width": 4.8}, {filter: filterId()});
  add("selected-ink", "line", "tracts", {"line-color": "#ffd0b4", "line-width": 2.35}, {filter: filterId()});
  add("hover-tract", "line", "tracts", {"line-color": "#f3ece2",
    "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0], "line-width": 1.8});
  add("commute-arcs", "line", "journeys", {"line-color": "#89c9cd",
    "line-width": ["interpolate", ["linear"], ["get", "jobs"], 1, .85, 100, 3.2, 600, 6],
    "line-opacity": .67}, {filter: ["==", ["geometry-type"], "LineString"], layout: {"line-cap": "round"}});
  add("commute-arc-focus", "line", "journeys", {"line-color": "#f3aa92",
    "line-width": ["interpolate", ["linear"], ["get", "jobs"], 1, 2, 100, 4.3, 600, 7],
    "line-opacity": .92}, {filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "geoid"], ""]],
    layout: {"line-cap": "round"}});
  add("destination-dot", "circle", "journeys", {"circle-color": "#89c9cd",
    "circle-radius": ["interpolate", ["linear"], ["get", "jobs"], 1, 3.1, 100, 7, 600, 12],
    "circle-stroke-color": "#121b25", "circle-stroke-width": 1.25},
  {filter: ["==", ["get", "kind"], "destination"]});
  add("home-dot", "circle", "journeys", {"circle-color": "#121b25", "circle-stroke-color": "#f3aa92",
    "circle-stroke-width": 2, "circle-radius": 6.4}, {filter: ["==", ["get", "kind"], "home"]});
  add("local-dot", "circle", "journeys", {"circle-color": "#89c9cd", "circle-radius": 2.75},
    {filter: ["==", ["get", "kind"], "local"]});
  add("destination-focus", "circle", "journeys", {"circle-color": "rgba(0,0,0,0)", "circle-radius": 12,
    "circle-stroke-color": "#f3aa92", "circle-stroke-width": 2},
  {filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "geoid"], ""]]});
}

function updateLayers() {
  const {mode, nearOnly, category, buffers, selected, station, pair, destination} = state;
  const railMode = mode === "rail";
  const railVisible = mode !== "commute";
  const setVisibility = (layers, visible) => {
    for (const id of layers) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  };
  setVisibility(["rail-halo", "rail-line", "rail-station"], railVisible);
  setVisibility(["station-areas", "station-rings"], railMode && buffers);
  setVisibility(["station-focus"], railMode);
  map.setFilter("station-focus", ["==", ["id"], station?.id || ""]);

  const opacity = mode === "commute" ? .10
    : railMode ? ["case", ["get", "railNear"], .84, nearOnly ? .05 : .21]
    : category ? ["case", ["==", ["get", "quadrant"], category], .91, .13] : .86;
  map.setPaintProperty("tract-color", "fill-color", railMode ? railPalette : housingPalette);
  map.setPaintProperty("tract-color", "fill-opacity", opacity);
  map.setPaintProperty("tract-borders", "line-opacity", mode === "commute" ? .19 : .37);

  const selectedFilter = ["==", ["get", "geoid"], selected || ""];
  for (const id of ["selected-fill", "selected-halo", "selected-ink"]) map.setFilter(id, selectedFilter);
  const pairFilter = ["in", ["get", "geoid"], ["literal", pair ? examples[mode] || [] : []]];
  for (const id of ["pair-outline", "pair-ink"]) map.setFilter(id, pairFilter);
  const destinationFilter = ["==", ["get", "geoid"], destination || ""];
  map.setFilter("destination-focus", ["all", ["==", ["geometry-type"], "Point"], destinationFilter]);
  map.setFilter("commute-arc-focus", ["all", ["==", ["geometry-type"], "LineString"], destinationFilter]);
}

function renderPanel() {
  const {mode, nearOnly, buffers, category, pair, selected} = state;
  const {counts, nearCounts, thresholds, classifiedCount, railNearCount} = data.summary;
  const pairButtons = (ids, metric, value) => `<div class="pair">${ids.map((id) => {
    const item = tracts.get(id);
    return `<button type="button" data-tract="${id}" aria-pressed="${selected === id}">
      <strong>${namedTracts.get(id)}</strong><span>${metric(item)}</span>
      <span class="pair-bar" aria-hidden="true"><i style="width:${value(item)}%"></i></span></button>`;
  }).join("")}</div>`;

  if (mode === "housing") {
    const cells = classes.slice(0, 4).map((item) => `<button type="button" data-category="${item.id}"
      aria-pressed="${category === item.id}" class="${category && category !== item.id ? "dim" : ""}"
      style="background:${item.color};color:${item.text}">${item.name.replace(", ", "<br>")}
      <small>${format(counts[item.id])} tracts</small></button>`).join("");
    $("#chapter-panel").innerHTML = `
      <h2>High rent, high strain?</h2>
      <p>Explore four combinations across ${format(classifiedCount)} tracts. Select a cell to isolate it.</p>
      <div class="matrix" aria-label="Bivariate map legend">
        <div class="matrix-caption"><span>Below ${money(thresholds.rent)}</span><span>${money(thresholds.rent)} or above</span></div>
        <div class="matrix-inner"><span class="matrix-y">Burden ↑</span><div class="matrix-grid">${cells}</div></div>
        <div class="matrix-x">Median gross rent →</div>
      </div>
      <div class="matrix-note">Burden split at ${percent(thresholds.burden, 2)} of renters. Dark slate indicates missing housing data.</div>
      <button class="action" type="button" data-action="compare-housing"><span>Compare tracts $15 apart in estimated rent</span><span aria-hidden="true">↗</span></button>
      ${pair ? pairButtons(examples.housing, (p) => `${money(p.rent)} · ${percent(p.burden)} burden`, (p) => p.burden) : ""}`;
  } else if (railMode()) {
    const lower = nearCounts["lower-rent-higher-burden"];
    const total = lower + nearCounts["higher-rent-higher-burden"];
    $("#chapter-panel").innerHTML = `
      <h2>What changes near rail?</h2>
      <p>We count a tract as near rail when buffers cover at least half its area. Of the ${format(railNearCount)} near-rail tracts, ${format(total)} have higher renter burden.</p>
      <div class="rail-summary"><strong>${format(lower)}/${format(total)}</strong><span>of those higher-burden tracts have lower median rent.</span></div>
      <div class="toggles">
        <button type="button" data-action="toggle-buffers" aria-pressed="${buffers}">800 m buffers</button>
        <button type="button" data-action="toggle-near" aria-pressed="${nearOnly}">Emphasize near rail</button>
      </div>
      <button class="action" type="button" data-action="compare-rail"><span>Compare Koreatown and Sun Valley</span><span aria-hidden="true">↗</span></button>
      ${pair ? pairButtons(examples.rail, (p) => `${percent(p.railCoverage, 0)} rail coverage`, (p) => p.railCoverage) : ""}`;
  } else {
    $("#chapter-panel").innerHTML = `
      <h2>Where do residents work?</h2>
      <p>Follow links from one home tract to its top LA County workplace tracts. Thicker links represent more primary jobs.</p>
      <div class="pair commute-pair" aria-label="Example home tracts">${examples.rail.map((id) =>
        `<button type="button" data-origin="${id}" aria-pressed="${selected === id}"><strong>${namedTracts.get(id)}</strong><span>Show job links ↗</span></button>`).join("")}</div>`;
  }
}

function railMode() {
  return state.mode === "rail";
}

function tractName(props) {
  return namedTracts.has(props.geoid) ? `${namedTracts.get(props.geoid)} · tract ${props.tract}` : `Tract ${props.tract}`;
}

function renderSelection() {
  const {selected, mode, station, destination} = state;
  const node = $("#selection");
  if (station && railMode()) {
    node.innerHTML = `<p class="kicker">SELECTED STATION</p><h3>${esc(station.name)}</h3>
      <p>Metro line ${esc(station.lines)}</p>
      ${selected ? '<button class="side-link" type="button" data-action="return-tract">Back to the selected tract</button>' : ""}`;
    return;
  }
  if (!selected) {
    const message = mode === "housing" ? "Click a tract to see its rent, burden and rail proximity."
      : "Click a tract to see how much of its area falls inside the 800 m station buffers.";
    node.innerHTML = `<p>${message}</p>`;
    return;
  }

  const p = tracts.get(selected);
  const klass = classes.find((entry) => entry.id === p.quadrant);
  const header = `<p class="kicker">${mode === "commute" ? "HOME TRACT" : "SELECTED TRACT"}</p><h3>${esc(tractName(p))}</h3>`;
  const housing = `<div class="metrics">
    <div class="metric"><strong>${money(p.rent)}</strong><small>Median gross rent</small></div>
    <div class="metric"><strong class="burden">${percent(p.burden)}</strong><small>Rent-burdened</small></div>
  </div>`;

  if (mode === "housing") {
    node.innerHTML = `${header}${housing}<p>${klass.name}</p>
      <small>${p.burden == null ? "Burden estimate unavailable." : `${format(p.burdened)} of ${format(p.renters)} renter households with a computable ratio.`}
      ${p.rentMoe == null ? "" : ` Rent estimate ±${money(p.rentMoe)} (90% margin of error).`}</small>
      <button class="side-link" type="button" data-action="go-rail">Check rail proximity ↗</button>`;
    return;
  }
  if (railMode()) {
    node.innerHTML = `${header}<div class="metrics">
      <div class="metric"><strong class="burden">${percent(p.railCoverage)}</strong><small>Area within 800 m</small></div>
      <div class="metric"><strong>${percent(p.burden)}</strong><small>Rent-burdened</small></div>
    </div><p>${p.railNear ? "Meets the near-rail threshold." : "Below the 50% near-rail threshold."}</p>
    <small>${p.nearestStation ? `Nearest to the tract point: ${esc(p.nearestStation)} · ${format(p.stationMeters)} m straight-line.` : ""}</small>
    <button class="side-link" type="button" data-action="go-commute">See where residents work ↗</button>`;
    return;
  }

  const jobs = data.commute.origins[selected];
  if (!jobs?.destinations.length) {
    node.innerHTML = `${header}<p>No county workplace links are available for this tract in the packaged 2024 data.</p>`;
    return;
  }
  const displayed = currentFlows.reduce((total, item) => total + item.jobs, 0);
  const highlighted = currentFlows.find((item) => item.geoid === destination);
  const rows = currentFlows.map((item, index) => {
    const label = item.geoid === selected ? "Within home tract" : tractName(tracts.get(item.geoid));
    return `<li><button type="button" data-destination="${item.geoid}" aria-pressed="${item.geoid === destination}">
      <span>${index + 1}. ${esc(label)}</span><strong>${format(item.jobs)}</strong></button></li>`;
  }).join("");
  node.innerHTML = `${header}<div class="metrics">
    <div class="metric"><strong class="burden">${format(jobs.losAngelesJobs)}</strong><small>Primary jobs in LA County</small></div>
    <div class="metric"><strong>${format(jobs.californiaJobs)}</strong><small>Primary jobs in California</small></div>
  </div>
  <p id="destination-detail">${highlighted ? `${highlighted.geoid === selected ? "Within the home tract" : esc(tractName(tracts.get(destination)))} · ${format(highlighted.jobs)} jobs.` :
    `The ${currentFlows.length} shown account for ${format(displayed)} county jobs (${percent(100 * displayed / jobs.losAngelesJobs)}).`}</p>
  <details class="destinations" open><summary>Ranked workplace tracts</summary><ol>${rows}</ol></details>`;
}

function renderKey() {
  const key = (type, text) => `<span class="key-item"><i class="key-swatch ${type}" aria-hidden="true"></i>${text}</span>`;
  const filterButton = ({id, name, color}) => `<button class="key-item" type="button" data-category="${id}"
    aria-pressed="${state.category === id}"><i class="key-swatch quadrant" aria-hidden="true" style="background:${color}"></i>${name}</button>`;
  $("#map-key").innerHTML = state.mode === "commute"
    ? key("home", "Home tract") + key("destination", "Workplace tract") + key("arc", "More jobs → wider link")
    : state.mode === "housing"
      ? classes.slice(0, 4).map(filterButton).join("") + key("missing", "Missing data")
      : key("rail-line", "Metro rail") + key("station", "Station") +
      (railMode() && state.buffers ? key("buffer", "800 m buffer") : "") +
      key("near-high", "Near rail · higher burden") + key("near-low", "Near rail · lower burden") +
      key("near-missing", "Near rail · burden unavailable");
}

function render() {
  const story = stories[state.mode];
  $("#map-title").textContent = story.title;
  $("#map-subtitle").textContent = story.subtitle;
  $("#map-instruction").textContent = story.instruction;
  for (const button of document.querySelectorAll(".chapters button")) {
    button.setAttribute("aria-pressed", button.dataset.mode === state.mode);
  }
  updateLayers();
  renderPanel();
  renderSelection();
  renderKey();
  updateDockOffset();
}

function pointOf(item) {
  return [item.lng, item.lat];
}

function curvedLink(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const bend = .16;
  const mid = [(from[0] + to[0]) / 2 - bend * dy, (from[1] + to[1]) / 2 + bend * dx];
  return Array.from({length: 21}, (_, index) => {
    const t = index / 20;
    const a = (1 - t) ** 2;
    const b = 2 * t * (1 - t);
    return [a * from[0] + b * mid[0] + t ** 2 * to[0], a * from[1] + b * mid[1] + t ** 2 * to[1]];
  });
}

function syncFlows() {
  currentFlows = [];
  const features = [];
  const origin = tracts.get(state.selected);
  if (state.mode === "commute" && origin) {
    const from = pointOf(origin);
    const pair = data.commute.origins[origin.geoid];
    const point = (coordinates, properties) => ({type: "Feature", geometry: {type: "Point", coordinates}, properties});
    for (const [geoid, jobs] of pair?.destinations || []) {
      const workplace = tracts.get(geoid);
      if (!workplace) continue;
      const to = pointOf(workplace);
      const route = geoid === origin.geoid ? null : curvedLink(from, to);
      currentFlows.push({geoid, jobs, to, route});
      if (!route) {
        features.push(point(from, {kind: "local", jobs, geoid}));
        continue;
      }
      features.push({type: "Feature", geometry: {type: "LineString", coordinates: route}, properties: {geoid, jobs}});
      features.push(point(to, {kind: "destination", jobs, geoid}));
    }
    features.push(point(from, {kind: "home", geoid: origin.geoid}));
  }
  map.getSource("journeys").setData({type: "FeatureCollection", features});
  syncFlowMotion();
}

// The moving dots travel outward along the displayed arcs. They indicate direction.
function syncFlowMotion() {
  const canvas = $("#flow-motion");
  const movingFlows = currentFlows.filter((item) => item.route);
  cancelAnimationFrame(flowFrame);
  canvas.hidden = reducedMotion.matches || !movingFlows.length;
  if (canvas.hidden) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const draw = (time) => {
    const scale = Math.min(devicePixelRatio || 1, 2);
    const {clientWidth, clientHeight} = map.getContainer();
    const width = Math.round(clientWidth * scale);
    const height = Math.round(clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, clientWidth, clientHeight);
    movingFlows.forEach(({route}, index) => {
      const progress = ((time / 4400 + index * .117) % 1) * (route.length - 1);
      const segment = Math.min(route.length - 2, Math.floor(progress));
      const fraction = progress - segment;
      const from = map.project(route[segment]);
      const to = map.project(route[segment + 1]);
      const x = from.x + (to.x - from.x) * fraction;
      const y = from.y + (to.y - from.y) * fraction;
      context.fillStyle = "rgba(150, 221, 224, .20)";
      context.beginPath();
      context.arc(x, y, 4.6, 0, 2 * Math.PI);
      context.fill();
      context.fillStyle = "#d1f9f5";
      context.beginPath();
      context.arc(x, y, 1.8, 0, 2 * Math.PI);
      context.fill();
    });
    flowFrame = requestAnimationFrame(draw);
  };
  flowFrame = requestAnimationFrame(draw);
}

function updateDockOffset() {
  const caption = $(".map-caption").getBoundingClientRect();
  const bottom = $(".atlas").clientHeight - caption.top + 8;
  $(".side").style.setProperty("--dock-bottom", `${bottom}px`);
}

function setDock(view) {
  state.dock = view;
  $("#show-guide").setAttribute("aria-expanded", view === "guide");
  $("#show-selection").setAttribute("aria-expanded", view === "selection");
  $("#close-panel").hidden = !view;
  $(".dock-content").hidden = !view;
  $("#guide-view").hidden = view !== "guide";
  $("#selection").hidden = view !== "selection";
  $(".dock-content").scrollTop = 0;
}

function frameBounds(bounds, maxZoom, duration) {
  const {clientWidth: width, clientHeight: height} = map.getContainer();
  const header = $(".map-header").getBoundingClientRect();
  const caption = $(".map-caption").getBoundingClientRect();
  const dock = $(".side").getBoundingClientRect();
  const narrow = width <= 740;
  const padding = {
    top: Math.min(header.bottom + 12, height * .30),
    left: narrow ? 25 : 49,
    right: narrow ? 29 : state.dock ? Math.min(width - dock.left + 26, width * .43) : 70,
    bottom: Math.min(height - (narrow ? dock.top : caption.top) + 15, height * .47)
  };
  const camera = map.cameraForBounds(bounds, {padding, maxZoom});
  if (camera) map.easeTo({...camera, duration: reducedMotion.matches ? 0 : duration});
}

function resetView() {
  const narrow = map.getContainer().clientWidth <= 740;
  const bounds = narrow ? [[-118.58, 33.84], [-118.02, 34.28]] : [[-118.73, 33.77], [-117.94, 34.31]];
  frameBounds(bounds, 11.3, 540);
}

function countyView() {
  frameBounds([[-118.96, 32.79], [-117.64, 34.83]], 10.5, 620);
}

function fitPoints(points, maxZoom = 12.65) {
  const bounds = points.reduce((result, point) => result.extend(point), new maplibregl.LngLatBounds(points[0], points[0]));
  frameBounds(bounds, maxZoom, 720);
}

function frameFlows() {
  const origin = tracts.get(state.selected);
  if (origin) fitPoints([pointOf(origin), ...currentFlows.flatMap(({route}) => route || [])], 11.8);
}

function selectTract(id, {zoom = false, showFlows = false, showDetails = false} = {}) {
  const item = tracts.get(id);
  if (!item) return;
  state.selected = id;
  state.destination = null;
  state.station = null;
  if (showDetails) setDock("selection");
  syncFlows();
  render();
  if (state.mode === "commute" && (showFlows || zoom)) frameFlows();
  else if (zoom) fitPoints([pointOf(item)]);
}

function openChapter(mode) {
  if (!stories[mode] || mode === state.mode) return;
  state.mode = mode;
  state.pair = false;
  state.station = null;
  state.destination = null;
  if (mode === "commute" && !state.selected) state.selected = examples.rail[0];
  if (mode === "commute" && state.dock === "guide") setDock("selection");
  syncFlows();
  render();
  if (mode === "commute") frameFlows();
}

function compare(mode) {
  state.pair = true;
  state.category = null;
  state.nearOnly = false;
  if (mode === "rail") state.buffers = true;
  selectTract(examples[mode][0]);
  fitPoints(examples[mode].map((id) => pointOf(tracts.get(id))), 12.1);
}

function selectDestination(geoid) {
  if (!currentFlows.some((item) => item.geoid === geoid)) return;
  state.destination = state.destination === geoid ? null : geoid;
  updateLayers();
  const scroll = $(".destinations ol")?.scrollTop || 0;
  renderSelection();
  if ($(".destinations ol")) $(".destinations ol").scrollTop = scroll;
}

function hoverId(id) {
  if (state.hovered === id) return;
  if (state.hovered != null) map.removeFeatureState({source: "tracts", id: state.hovered}, "hover");
  if (id != null) map.setFeatureState({source: "tracts", id}, {hover: true});
  state.hovered = id;
}

function featureAt(event, layers) {
  return map.queryRenderedFeatures(event.point, {layers})[0];
}

function mapInteract() {
  const hover = $("#hover-card");
  map.on("click", (event) => {
    if (railMode()) {
      const station = featureAt(event, ["rail-station"]);
      if (station) {
        state.station = {id: station.id, ...station.properties};
        setDock("selection");
        updateLayers();
        renderSelection();
        return;
      }
    }
    if (state.mode === "commute") {
      const workplace = featureAt(event, ["destination-dot", "home-dot"]);
      if (workplace?.properties.kind === "destination") {
        setDock("selection");
        selectDestination(workplace.properties.geoid);
        return;
      }
      if (workplace?.properties.kind === "home" && currentFlows.some((item) => item.geoid === state.selected)) {
        setDock("selection");
        selectDestination(state.selected);
        return;
      }
    }
    const tract = featureAt(event, ["tract-color"]);
    if (tract) selectTract(tract.properties.geoid, {showFlows: state.mode === "commute", showDetails: true});
  });

  map.on("mousemove", (event) => {
    const tract = featureAt(event, ["tract-color"]);
    const station = railMode() ? featureAt(event, ["rail-station"]) : null;
    const workplace = state.mode === "commute" ? featureAt(event, ["destination-dot", "home-dot"]) : null;
    map.getCanvas().style.cursor = tract || station || workplace ? "pointer" : "";
    hoverId(station || workplace ? null : tract?.id);
    if (!tract && !station && !workplace) {
      hover.hidden = true;
      return;
    }
    if (station) {
      hover.innerHTML = `<strong>${esc(station.properties.name)}</strong><br>Metro ${esc(station.properties.lines)}`;
    } else if (workplace) {
      const geoid = workplace.properties.geoid;
      hover.innerHTML = `<strong>${workplace.properties.kind === "home" ? "Home" : "Workplace"}</strong> · ${esc(tractName(tracts.get(geoid)))}
        ${workplace.properties.jobs ? `<br>${format(workplace.properties.jobs)} primary jobs` : ""}`;
    } else {
      const p = tracts.get(tract.properties.geoid);
      const detail = railMode() ? `${percent(p.railCoverage)} within 800 m` : state.mode === "commute" ?
        "Select as home tract" : `${money(p.rent)} · ${percent(p.burden)} burdened`;
      hover.innerHTML = `<strong>${esc(tractName(p))}</strong><br>${detail}`;
    }
    hover.hidden = false;
    hover.style.left = `${Math.min(event.point.x + 13, map.getContainer().clientWidth - hover.offsetWidth - 5)}px`;
    hover.style.top = `${Math.max(5, event.point.y - hover.offsetHeight - 12)}px`;
  });
  map.getCanvas().addEventListener("mouseleave", () => {
    hoverId(null);
    hover.hidden = true;
  });
  map.on("movestart", () => { hover.hidden = true; });
}

function installLabels() {
  const root = $("#place-labels");
  const preferred = new Set(["Los Angeles", "Downtown Los Angeles", "Koreatown", "Sun Valley", "Long Beach", "Pasadena", "Santa Monica", "Burbank", "Glendale"]);
  const placeFeatures = data.context.features.filter((item) => item.properties.kind === "place");
  placeFeatures.push({properties: {name: "Pacific Ocean", minzoom: 7, rank: 1, water: true},
    geometry: {coordinates: [-118.57, 33.84]}});
  placeFeatures.sort((a, b) => {
    const weight = (item) => item.properties.water ? 0 : preferred.has(item.properties.name) ? 1 : item.properties.rank + 2;
    return weight(a) - weight(b);
  });
  state.labels = placeFeatures.map(({properties, geometry}) => {
    const node = document.createElement("span");
    node.className = `place-label${properties.water ? " water" : preferred.has(properties.name) ? " primary" : ""}`;
    node.textContent = properties.name;
    node.hidden = true;
    root.append(node);
    return {node, coords: geometry.coordinates, minZoom: properties.minzoom};
  });
  let pending = false;
  const update = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const zoom = map.getZoom();
      const {clientWidth: width, clientHeight: height} = root;
      const occupied = [];
      const overlays = [...document.querySelectorAll(".wordmark, .chapters, .map-heading, .map-actions, .map-caption, .dock-bar, .dock-content, .source-links, .maplibregl-ctrl-top-right")]
        .filter((node) => node.getClientRects().length).map((node) => node.getBoundingClientRect());
      for (const {node, coords, minZoom} of state.labels) {
        const p = map.project(coords);
        const halfWidth = node.textContent.length * (node.classList.contains("water") ? 4.8 : 3.35);
        const onScreen = p.x >= halfWidth + 8 && p.x <= width - halfWidth - 8 && p.y >= 12 && p.y <= height - 12;
        const collision = occupied.some((item) => Math.abs(item.x - p.x) < item.halfWidth + halfWidth + 8 && Math.abs(item.y - p.y) < 15);
        const covered = overlays.some((rect) => p.x + halfWidth + 6 > rect.left && p.x - halfWidth - 6 < rect.right
          && p.y + 10 > rect.top && p.y - 10 < rect.bottom);
        const show = zoom + .25 >= minZoom && onScreen && !collision && !covered;
        node.hidden = !show;
        if (!show) continue;
        node.style.left = `${p.x}px`;
        node.style.top = `${p.y}px`;
        occupied.push({x: p.x, y: p.y, halfWidth});
      }
    });
  };
  map.on("move", update);
  map.on("resize", update);
  const overlayObserver = new ResizeObserver(update);
  for (const overlay of document.querySelectorAll(".map-header, .side, .map-caption")) overlayObserver.observe(overlay);
  update();
}

function restoreFocus(selector) {
  const element = document.querySelector(selector);
  if (element) element.focus({preventScroll: true});
}

function toggleCategory(category, scope) {
  state.category = state.category === category ? null : category;
  updateLayers();
  renderPanel();
  renderKey();
  updateDockOffset();
  restoreFocus(`${scope} [data-category="${category}"]`);
}

function wireControls() {
  $("#map-key").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (button) toggleCategory(button.dataset.category, "#map-key");
  });
  $(".chapters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (button) openChapter(button.dataset.mode);
  });
  $("#show-guide").addEventListener("click", () => setDock(state.dock === "guide" ? null : "guide"));
  $("#show-selection").addEventListener("click", () => setDock(state.dock === "selection" ? null : "selection"));
  $("#close-panel").addEventListener("click", () => {
    const previous = state.dock;
    setDock(null);
    restoreFocus(previous === "guide" ? "#show-guide" : "#show-selection");
  });
  $("#open-methods").addEventListener("click", () => $("#methods").showModal());
  map.on("resize", updateDockOffset);
  $("#reset-view").addEventListener("click", resetView);
  $("#county-view").addEventListener("click", countyView);
  reducedMotion.addEventListener("change", syncFlowMotion);
  $(".side").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const {action, category, tract, origin, destination} = button.dataset;
    if (category) toggleCategory(category, "#chapter-panel");
    if (tract || origin) {
      selectTract(tract || origin, {zoom: true, showDetails: Boolean(origin)});
      restoreFocus(tract ? `[data-tract="${tract}"]` : "#show-selection");
    }
    if (destination) {
      selectDestination(destination);
      restoreFocus(`[data-destination="${destination}"]`);
    }
    if (action === "compare-housing" || action === "compare-rail") compare(state.mode);
    if (action === "toggle-buffers" || action === "toggle-near") {
      if (action === "toggle-buffers") state.buffers = !state.buffers;
      else state.nearOnly = !state.nearOnly;
      render();
    }
    if (action === "go-rail" || action === "go-commute") {
      openChapter(action.slice(3));
      restoreFocus(`[data-mode="${state.mode}"]`);
    }
    if (action === "return-tract") {
      state.station = null;
      updateLayers();
      renderSelection();
    }
    if (action) restoreFocus(`[data-action="${action}"]`);
  });
  $("#tract-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("#tract-input").value.trim();
    let id = value;
    if (!tracts.has(id)) {
      const tractNumber = Number(value);
      const match = Number.isFinite(tractNumber) && [...tracts.values()].find((item) => Number(item.tract) === tractNumber);
      id = match?.geoid;
    }
    $("#finder-feedback").textContent = id && tracts.has(id) ? "" : "Tract not found. Try an 11-digit Los Angeles County GEOID or tract number.";
    if (id && tracts.has(id)) {
      selectTract(id, {zoom: true, showDetails: true});
      restoreFocus("#show-selection");
    }
  });
}

async function start() {
  const message = $("#map-message");
  try {
    if (!window.maplibregl) throw new Error("MapLibre failed to load");
    data = await loadData();
    tracts = new Map(data.tracts.features.map((feature) => [feature.properties.geoid, feature.properties]));
    const sources = Object.fromEntries(["context", "tracts", "rail", "stations", "buffers", "rings"].map((key) =>
      [key, {type: "geojson", data: data[key], ...(key === "tracts" ? {promoteId: "geoid"} : {})}]));
    sources.journeys = {type: "geojson", data: blank()};
    map = new maplibregl.Map({
      container: "map",
      style: {version: 8, sources, layers: [{id: "water", type: "background", paint: {"background-color": "#172d3b"}}]},
      center: [-118.32, 34.04], zoom: 9.7, minZoom: 6.4, maxZoom: 15.2,
      maxBounds: [[-120.1, 32.55], [-116.2, 35.5]],
      dragRotate: false, pitchWithRotate: false, renderWorldCopies: false,
      attributionControl: false
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-right");
    map.addControl(new maplibregl.ScaleControl({unit: "metric", maxWidth: 105}), "bottom-left");
    map.on("error", ({error}) => console.error(error));
    map.once("load", () => {
      try {
        addLayers();
        installLabels();
        wireControls();
        mapInteract();
        render();
        resetView();
        message.textContent = "";
      } catch (error) {
        console.error(error);
        message.textContent = "The atlas could not draw its map layers. Reload to try again.";
      }
    });
  } catch (error) {
    console.error(error);
    message.textContent = "The atlas could not start. Keep the extracted files together and try a browser with WebGL enabled.";
  }
}

start();
