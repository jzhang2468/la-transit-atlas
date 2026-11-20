#!/usr/bin/env python3
"""Rebuild the Van Nuys / Reseda comparison with Python 3, shapely>=2.1, pyproj and pyshp.

Run from any directory: python reproduce/prepare_neighborhoods.py --cache ./source-cache
Public downloads are cached. The published historical-rail-screen.csv and tracts.geojson
in data/ retain the mapped rail classes and ACS rent-burden totals.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
from io import TextIOWrapper
import json
from math import atan2, degrees
from pathlib import Path
import shutil
from urllib.parse import urlencode
from urllib.request import urlopen
from zipfile import ZipFile

import shapefile
from pyproj import Transformer
from shapely import LineString, Point, box, union_all, transform
from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parents[1]
DAY = "20261030"
START, END = 19 * 60, 21 * 60
CASES = {"06037128303": "Van Nuys", "06037132502": "Reseda"}
METRO_SHA = "07096221c6af460b7558cb106fbf7c8d975ed418"
GTFS_URL = f"https://gitlab.com/LACMTA/gtfs_bus/-/raw/{METRO_SHA}/gtfs_bus.zip"
CENSUS = "https://www2.census.gov"
VEHICLE_URL = f"{CENSUS}/programs-surveys/acs/summary_file/2023/table-based-SF/data/5YRData/acsdt5y2023-b25044.dat"
ROADS_URL = f"{CENSUS}/geo/tiger/TIGER2023/ROADS/tl_2023_06037_roads.zip"
TRACT_URL = f"{CENSUS}/geo/tiger/TIGER2023/TRACT/tl_2023_06_tract.zip"
NC_URL = "https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/18"
NC_QUERY = urlencode(
    dict(where="1=1", outFields="NAME", outSR=4326, geometryPrecision=5, f="geojson")
)
PROJECT = Transformer.from_crs(4326, 26911, always_xy=True).transform
INVERSE = Transformer.from_crs(26911, 4326, always_xy=True).transform


def cached(cache, name, url, digest=None):
    path = cache / name
    if not path.exists():
        temporary = path.with_suffix(".partial")
        try:
            with urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    if digest and hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError(f"Source digest mismatch: {path}")
    return path


def gtfs_rows(archive, filename):
    with archive.open(filename + ".txt") as raw, TextIOWrapper(raw, encoding="utf-8-sig") as stream:
        yield from csv.DictReader(stream)


def collect_bus_data(archive):
    active = {
        r["service_id"]
        for r in gtfs_rows(archive, "calendar")
        if r["friday"] == "1" and r["start_date"] <= DAY <= r["end_date"]
    }
    for row in gtfs_rows(archive, "calendar_dates"):
        if row["date"] == DAY:
            if row["exception_type"] == "1":
                active.add(row["service_id"])
            elif row["exception_type"] == "2":
                active.discard(row["service_id"])
    trips = {r["trip_id"]: r for r in gtfs_rows(archive, "trips") if r["service_id"] in active}
    stops = {r["stop_id"]: r for r in gtfs_rows(archive, "stops")}
    routes = {r["route_id"]: r for r in gtfs_rows(archive, "routes")}
    by_stop = defaultdict(lambda: defaultdict(list))
    for r in gtfs_rows(archive, "stop_times"):
        trip = trips.get(r["trip_id"])
        if trip is None or r["pickup_type"] not in {"", "0"}:
            continue
        h, m, s = map(int, r["departure_time"].split(":"))
        seconds = 3600 * h + 60 * m + s
        if START * 60 <= seconds < END * 60:
            by_stop[r["stop_id"]][trip["route_id"], trip["direction_id"]].append(
                (seconds, r["stop_headsign"], trip["shape_id"], trip["trip_id"])
            )
    return routes, stops, by_stop


def stop_point(stop):
    return Point(float(stop["stop_lon"]), float(stop["stop_lat"]))


def load_shapes(archive, wanted):
    parts = defaultdict(list)
    for r in gtfs_rows(archive, "shapes"):
        if r["shape_id"] in wanted:
            parts[r["shape_id"]].append(
                (int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"]))
            )
    return {s: LineString([(lng, lat) for _, lng, lat in sorted(rr)]) for s, rr in parts.items()}


def nearby_stop(center, stops, by_stop):
    projected = transform(center, PROJECT, interleaved=False)

    def distance(sid):
        return transform(stop_point(stops[sid]), PROJECT, interleaved=False).distance(projected)

    sid = min(by_stop, key=lambda s: (distance(s), s))
    groups = by_stop[sid]
    key = min(groups, key=lambda k: (-len(groups[k]), k))
    return sid, key, round(distance(sid)), sorted(groups[key])


def cardinal(shape_geo, stop):
    line = transform(shape_geo, PROJECT, interleaved=False)
    here = line.project(transform(stop, PROJECT, interleaved=False))
    before, after = line.interpolate(max(0, here - 45)), line.interpolate(
        min(line.length, here + 45)
    )
    angle = degrees(atan2(after.x - before.x, after.y - before.y)) % 360
    return ["Northbound", "Eastbound", "Southbound", "Westbound"][int((angle + 45) // 90) % 4]


def clean_geometry(geom):
    """Coordinates to six decimals (sub-meter display precision)."""
    return json.loads(json.dumps(mapping(geom)), parse_float=lambda x: round(float(x), 6))


def feature(geom, **properties):
    return {"type": "Feature", "properties": properties, "geometry": clean_geometry(geom)}


def collection(features):
    return {"type": "FeatureCollection", "features": features}


def streets(path, extent):
    buckets = defaultdict(list)
    with shapefile.Reader(str(path)) as reader:
        for sr in reader.iterShapeRecords(bbox=extent.bounds, fields=["FULLNAME", "MTFCC"]):
            name, mtfcc = sr.record["FULLNAME"], sr.record["MTFCC"]
            if mtfcc not in {"S1100", "S1200", "S1400", "S1630", "S1640"}:
                continue
            clipped = shape(sr.shape.__geo_interface__).intersection(extent)
            if clipped.geom_type in {"LineString", "MultiLineString"} and not clipped.is_empty:
                kind = "highway" if mtfcc in {"S1100", "S1630"} else "road"
                buckets[name or "", kind].append(clipped)
    return collection(
        [
            feature(union_all(parts).simplify(0.000015), name=name, kind=kind)
            for (name, kind), parts in sorted(buckets.items())
        ]
    )


def read_case_polygons(path):
    polygons = {}
    with shapefile.Reader(str(path)) as reader:
        for rec in reader.iterRecords(fields=["GEOID"]):
            if rec["GEOID"] in CASES:
                polygons[rec["GEOID"]] = shape(reader.shape(rec.oid).__geo_interface__)
    return polygons


def build(cache):
    bus = cached(
        cache,
        "bus_gtfs.zip",
        GTFS_URL,
        "cb1a2283abecc0af1619365ea0626262bc3d93d5e6bdd0df03288cd6120f6058",
    )
    roads = cached(
        cache,
        "roads.zip",
        ROADS_URL,
        "8edc126cb2bd5f8cc6009a73e26e2aa43209fc897c6743677ada0cc1c9201243",
    )
    tract_file = cached(
        cache,
        "tiger-tracts.zip",
        TRACT_URL,
        "ca4612dcf887229515f1996aa77c38ec81d296e3bc59d514bfd9463606dcd96f",
    )
    vehicles = cached(cache, "B25044_la_2023.dat", VEHICLE_URL)
    councils = json.loads(cached(cache, "councils.json", f"{NC_URL}/query?{NC_QUERY}").read_text())[
        "features"
    ]
    with vehicles.open() as f:
        acs = {
            r["GEO_ID"][-11:]: r
            for r in csv.DictReader(f, delimiter="|")
            if r["GEO_ID"].startswith("1400000US") and r["GEO_ID"][-11:] in CASES
        }
    tracts = {
        f["properties"]["geoid"]: f["properties"]
        for f in json.loads((ROOT / "data/tracts.geojson").read_text())["features"]
    }
    with (ROOT / "data/historical-rail-screen.csv").open() as fp:
        cohort = {r["geoid"] for r in csv.DictReader(fp) if r["category"] == "pink"}
    if len(cohort) != 235 or not set(CASES) <= cohort:
        raise ValueError("The two chosen tracts must belong to the 235-tract published map class.")
    polygons = read_case_polygons(tract_file)
    results = []
    with ZipFile(bus) as archive:
        routes, stops, by_stop = collect_bus_data(archive)
        for geoid, name in CASES.items():
            t = tracts[geoid]
            center = Point(t["lng"], t["lat"])
            council_names = [
                f["properties"]["NAME"] for f in councils if shape(f["geometry"]).covers(center)
            ]
            if f"{name.upper()} NC" not in council_names:
                raise ValueError(f"Neighborhood council intersection did not match {name}.")
            sid, (route_id, direction_id), dist, events = nearby_stop(center, stops, by_stop)
            if dist > 400:
                raise ValueError("No representative stop within 400 m of the tract internal point.")
            route = routes[route_id]
            stop = stops[sid]
            point = stop_point(stop)
            x, y = PROJECT(center.x, center.y)
            extent = transform(
                box(x - 2000, y - 2000, x + 2000, y + 2000), INVERSE, interleaved=False
            )
            shapes = load_shapes(archive, {event[2] for event in events})
            dominant_shape = Counter(event[2] for event in events).most_common(1)[0][0]
            direction = cardinal(shapes[dominant_shape], point)
            destinations = list(
                dict.fromkeys(e[1].removeprefix(route["route_short_name"] + " - ") for e in events)
            )
            schedule = [e[0] // 60 for e in events]
            if any(e[0] % 60 for e in events):
                raise ValueError("Sub-minute departures require chart precision changes.")
            a = acs[geoid]
            n = int(a["B25044_E009"])
            zero = int(a["B25044_E010"])
            nearby = [
                feature(stop_point(stops[i]), name=stops[i]["stop_name"], id=i)
                for i in sorted(by_stop)
                if extent.contains(stop_point(stops[i]))
            ]
            lines = union_all([line.intersection(extent) for line in shapes.values()]).simplify(
                0.000012
            )
            results.append(
                {
                    "name": name,
                    "council": f"{name} Neighborhood Council",
                    "tract": t["tract"],
                    "geoid": geoid,
                    "center": list(center.coords[0]),
                    "polygon": clean_geometry(polygons[geoid]),
                    "burden": round(100 * t["burdened"] / t["renters"], 4),
                    "zeroVehicle": round(100 * zero / n, 4),
                    "burdenN": t["renters"],
                    "burdened": t["burdened"],
                    "renters": n,
                    "noVehicleRenters": zero,
                    "noVehicleRentersMoe": int(a["B25044_M010"]),
                    "rentersMoe": int(a["B25044_M009"]),
                    "stop": {
                        "id": sid,
                        "name": stop["stop_name"],
                        "coordinates": list(point.coords[0]),
                        "distanceMeters": dist,
                    },
                    "route": {
                        "id": route_id,
                        "shortName": route["route_short_name"],
                        "longName": route["route_desc"],
                        "direction": direction,
                        "directionId": direction_id,
                        "headsign": " or ".join(destinations),
                        "destinations": destinations,
                    },
                    "departures": schedule,
                    "departureCount": len(schedule),
                    "maxGap": max(b - a for a, b in zip(schedule, schedule[1:])),
                    "lines": collection(
                        [feature(lines, selected=True, name=f'Metro {route["route_short_name"]}')]
                    ),
                    "stops": collection(nearby),
                    "context": streets(roads, extent),
                }
            )
    return {
        "date": "2026-10-30",
        "timeZone": "America/Los_Angeles",
        "window": [START, END],
        "cases": results,
        "gapDefinition": "Longest interval between successive displayed departures on the selected line and direction. Window edges are excluded.",
        "method": [
            "The two illustrative San Fernando Valley tracts both appear in the 235 high-burden, lower-rail-proximity tracts on the original housing-and-rail map. Internal points identify the corresponding city Neighborhood Council areas. Tract percentages are ACS estimates for 2019–2023.",
            "Rent burden is the share paying at least 30% of household income in gross rent among cash-rent households with a computable ratio. Vehicle availability is a separate tract estimate, the share of all renter households without a vehicle. These estimates have sampling error and do not identify a shared set of households.",
            "Both sites were purposefully chosen for similar estimated housing and vehicle conditions and contrasting evening schedules. Each stop is the closest Metro bus stop to its tract internal point with a regular scheduled pickup in the window. The displayed line and direction have the most listed departures at that stop; ties break by route ID and direction ID.",
            "Service includes scheduled regular pickups on Friday October 30, 2026 from 19:00 up to 21:00 local time, after applying calendar exceptions. Route branches in the same direction are counted together. The comparison describes these two stops on that evening; other stops, operators and actual running times are outside this measure.",
            "Map context uses 2023 TIGER/Line road centerlines and tract boundaries. The selected route follows scheduled GTFS shapes. Other dots indicate Metro bus stops with a regular pickup in the displayed window.",
        ],
        "sources": [
            {
                "name": "ACS 2019–2023 · B25070 rent burden",
                "url": "https://api.census.gov/data/2023/acs/acs5/groups/B25070.html",
            },
            {
                "name": "ACS 2019–2023 · B25044 vehicles by tenure",
                "url": "https://api.census.gov/data/2023/acs/acs5/groups/B25044.html",
            },
            {
                "name": "LA Metro · archived October 30, 2026 bus schedule",
                "url": f"https://gitlab.com/LACMTA/gtfs_bus/-/tree/{METRO_SHA}",
            },
            {"name": "City of Los Angeles · certified Neighborhood Councils", "url": NC_URL},
            {"name": "U.S. Census Bureau · 2023 TIGER/Line roads", "url": ROADS_URL},
            {"name": "U.S. Census Bureau · 2023 TIGER/Line tracts", "url": TRACT_URL},
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "data/neighborhoods.json")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    result = build(args.cache)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    for case in result["cases"]:
        print(
            case["name"],
            case["stop"]["name"],
            case["route"]["direction"],
            case["departures"],
            case["maxGap"],
        )
