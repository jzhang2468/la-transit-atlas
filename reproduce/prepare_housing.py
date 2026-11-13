#!/usr/bin/env python3
"""Join LA County ACS tables to tract geometry and derive Metro rail proximity.

Requires Python 3.10+ and shapely>=2.1, pyproj and pyshp.
From the atlas folder: python reproduce/prepare_housing.py --cache /tmp/la-atlas-housing

The cache downloads about 100 MB of dated Census and LA Metro source files.
The resulting GeoJSON and JSON files are already bundled with the atlas.
"""

import argparse
from collections import Counter, defaultdict
from csv import DictReader
from io import TextIOWrapper
import hashlib
import json
from pathlib import Path
import shutil
from statistics import median
from urllib.request import urlopen
from zipfile import ZipFile

from pyproj import Transformer
import shapefile
from shapely import (
    GeometryCollection, LineString, Point, STRtree, make_valid, transform, union_all,
)
from shapely.geometry import mapping, shape
from shapely.geometry.polygon import orient

FEED_DATE = "2026-11-13"
FEED_COMMIT = "a939fcc8ac7a2b6c26bf6962b91e8b0429649c88"
BUFFER_METERS = 800
COVERAGE_THRESHOLD = 50
TO_METERS = Transformer.from_crs(4326, 32611, always_xy=True).transform
TO_WGS84 = Transformer.from_crs(32611, 4326, always_xy=True).transform


CENSUS_ROOT = "https://www2.census.gov"
ACS_ROOT = f"{CENSUS_ROOT}/programs-surveys/acs/summary_file/2023/table-based-SF/data/5YRData"
CARTO_ROOT = f"{CENSUS_ROOT}/geo/tiger/GENZ2023/shp"
SOURCE_FILES = {
    "rent.dat": (
        f"{ACS_ROOT}/acsdt5y2023-b25064.dat",
        "8b887d1e102916ef12718e51a29ae303a562a1d7ac545756bfb6a76e3d7b96b7",
    ),
    "burden.dat": (
        f"{ACS_ROOT}/acsdt5y2023-b25070.dat",
        "a9e7afde4e71b7259a2e39a0e951d5d5a617616caaf3c3b98f5c503a0d813ecc",
    ),
    "population.dat": (
        f"{ACS_ROOT}/acsdt5y2023-b01003.dat",
        "24ae3f523b4c54332ce0a71ba534569685a8a729056f975915d860d1eb943565",
    ),
    "tiger-tracts.zip": (
        f"{CENSUS_ROOT}/geo/tiger/TIGER2023/TRACT/tl_2023_06_tract.zip",
        "ca4612dcf887229515f1996aa77c38ec81d296e3bc59d514bfd9463606dcd96f",
    ),
    "tracts.zip": (
        f"{CARTO_ROOT}/cb_2023_06_tract_500k.zip",
        "63afe6f8a9a10cee22dd8b2d9950b676909e9e9a0b3bd58703ea4fe9ee2107c4",
    ),
    "places.zip": (
        f"{CARTO_ROOT}/cb_2023_06_place_500k.zip",
        "72ec1bbfdec686577cc8c85581a4607a7e157ac3a3fc82fbef5dd54755016fe7",
    ),
    "rail.zip": (
        f"https://gitlab.com/LACMTA/gtfs_rail/-/raw/{FEED_COMMIT}/gtfs_rail.zip",
        "9bf1118bc78add6e87dcb4d5ff31c5b9e9bdd464f016f1aa53f9ad6e63ae55c5",
    ),
}


def verify_source(path, expected):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError(f"{path} differs from the recorded source. Verify the archive before rebuilding.")


def cache_sources(cache):
    cache.mkdir(parents=True, exist_ok=True)
    for filename, (url, expected) in SOURCE_FILES.items():
        path = cache / filename
        if path.is_file():
            verify_source(path, expected)
            continue
        part = path.with_suffix(".download")
        try:
            with urlopen(url, timeout=60) as response, part.open("wb") as file:
                shutil.copyfileobj(response, file)
            verify_source(part, expected)
            part.replace(path)
        finally:
            part.unlink(missing_ok=True)


def read_acs(path):
    with path.open() as stream:
        return {
            row["GEO_ID"][-11:]: row
            for row in DictReader(stream, delimiter="|")
            if row["GEO_ID"].startswith("1400000US06037")
        }


def parse_estimate(value):
    parsed = int(value)
    return parsed if parsed >= 0 else None


def housing_estimates(cache):
    rent_rows = read_acs(cache / "rent.dat")
    burden_rows = read_acs(cache / "burden.dat")
    population_rows = read_acs(cache / "population.dat")
    assert rent_rows.keys() == burden_rows.keys() == population_rows.keys()

    estimates = {}
    for geoid, rent_row in rent_rows.items():
        row = burden_rows[geoid]
        counts = [int(row[f"B25070_E{index:03}"]) for index in range(1, 12)]
        assert all(count >= 0 for count in counts)
        assert counts[0] == sum(counts[1:])
        renters = counts[0] - counts[10]
        burdened = sum(counts[6:10])
        estimates[geoid] = {
            "rent": parse_estimate(rent_row["B25064_E001"]),
            "rentMoe": parse_estimate(rent_row["B25064_M001"]),
            "burden": 100 * burdened / renters if renters else None,
            "renters": renters,
            "burdened": burdened,
            "population": parse_estimate(population_rows[geoid]["B01003_E001"]),
        }

    eligible = [
        props for props in estimates.values()
        if props["rent"] is not None and props["burden"] is not None
    ]
    return estimates, median(x["rent"] for x in eligible), median(x["burden"] for x in eligible)


def read_rail_feed(path):
    with ZipFile(path) as archive:
        def rows(table):
            return DictReader(TextIOWrapper(archive.open(f"{table}.txt"), encoding="utf-8-sig"))

        routes = {row["route_id"]: row for row in rows("routes")}
        trips = {row["trip_id"]: row for row in rows("trips")}
        stop_records = {row["stop_id"]: row for row in rows("stops")}
        served = defaultdict(set)
        for row in rows("stop_times"):
            platform = stop_records[row["stop_id"]]
            station = platform["parent_station"] or platform["stop_id"]
            served[station].add(trips[row["trip_id"]]["route_id"])

        shapes_by_route = defaultdict(set)
        for trip in trips.values():
            shapes_by_route[trip["route_id"]].add(trip["shape_id"])

        shape_rows = defaultdict(list)
        for row in rows("shapes"):
            shape_rows[row["shape_id"]].append((
                int(row["shape_pt_sequence"]),
                float(row["shape_pt_lon"]),
                float(row["shape_pt_lat"]),
            ))

    names = {key: route["route_long_name"].removeprefix("Metro ").split()[0] for key, route in routes.items()}
    stations = {}
    for station_id, route_ids in sorted(served.items()):
        row = stop_records[station_id]
        assert row["location_type"] == "1"
        geometry = Point(float(row["stop_lon"]), float(row["stop_lat"]))
        stations[station_id] = {
            "geometry": geometry,
            "name": row["stop_name"],
            "lines": " ".join(sorted(names[route_id] for route_id in route_ids)),
        }

    line_features = []
    for route_id, shapes in sorted(shapes_by_route.items(), key=lambda item: names[item[0]]):
        candidates = [
            LineString([(lon, lat) for _, lon, lat in sorted(shape_rows[shape_id])])
            for shape_id in sorted(shapes)
        ]
        # Each route has two directional shapes. The longer one follows the full route.
        line = max(candidates, key=lambda geom: project(geom).length)
        route = routes[route_id]
        props = {"line": names[route_id], "name": route["route_long_name"], "color": f"#{route['route_color']}"}
        line_features.append(feature(line, props, names[route_id]))
    return stations, line_features


def project(geometry):
    return transform(geometry, TO_METERS, interleaved=False)


def unproject(geometry):
    return transform(geometry, TO_WGS84, interleaved=False)


def rounded_geometry(geometry):
    result = mapping(geometry)

    def round_coordinates(item):
        if isinstance(item, (tuple, list)):
            return [round_coordinates(value) for value in item]
        return round(item, 6)

    result["coordinates"] = round_coordinates(result["coordinates"])
    return result


def polygonal(geometry):
    # Boundary data may contain ring contacts. Repair them without keeping isolated lines.
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    if isinstance(geometry, GeometryCollection):
        geometry = union_all([part for part in geometry.geoms if part.geom_type in ("Polygon", "MultiPolygon")])
    if geometry.geom_type == "Polygon":
        return orient(geometry)
    return geometry


def feature(geometry, properties, key=None):
    result = {"type": "Feature", "geometry": rounded_geometry(geometry), "properties": properties}
    if key is not None:
        result["id"] = key
    return result


def save_features(path, features):
    with path.open("w", encoding="utf-8") as stream:
        json.dump({"type": "FeatureCollection", "features": features}, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")


def quadrant(rent, burden, rent_threshold, burden_threshold):
    if rent is None or burden is None:
        return "no-data"
    rent_side = "higher" if rent >= rent_threshold else "lower"
    burden_side = "higher" if burden >= burden_threshold else "lower"
    return f"{rent_side}-rent-{burden_side}-burden"


def pct_covered(geom, buffer_parts, buffer_index):
    parts = buffer_index.query(geom, predicate="intersects")
    return min(100.0, 100 * sum(geom.intersection(buffer_parts[part]).area for part in parts) / geom.area)


def tract_layers(cache, estimates, rent_threshold, burden_threshold, stations):
    display = shapefile.Reader(str(cache / "tracts.zip"))
    display_geometry = {
        sr.record["GEOID"]: polygonal(shape(sr.shape.__geo_interface__))
        for sr in display.iterShapeRecords() if sr.record["COUNTYFP"] == "037"
    }
    tiger = shapefile.Reader(str(cache / "tiger-tracts.zip"))

    station_points = [project(station["geometry"]) for station in stations.values()]
    station_index = STRtree(station_points)
    station_values = list(stations.values())
    station_buffers = [point.buffer(BUFFER_METERS, quad_segs=32) for point in station_points]
    merged_buffers = union_all(station_buffers)
    buffer_parts = list(merged_buffers.geoms)
    buffer_index = STRtree(buffer_parts)

    tracts = []
    sensitivity_changes = 0
    for sr in tiger.iterShapeRecords():
        record = sr.record
        if record["COUNTYFP"] != "037" or record["ALAND"] == 0:
            continue

        geoid = record["GEOID"]
        props = estimates[geoid].copy()
        props["geoid"] = geoid
        props["tract"] = record["NAME"]
        props["quadrant"] = quadrant(props["rent"], props["burden"], rent_threshold, burden_threshold)
        if props["burden"] is not None:
            props["burden"] = round(props["burden"], 6)

        full_tract = project(polygonal(shape(sr.shape.__geo_interface__)))
        coverage = pct_covered(full_tract, buffer_parts, buffer_index)
        props["railCoverage"] = round(coverage, 4)
        props["railNear"] = coverage >= COVERAGE_THRESHOLD
        props["landKm2"] = round(record["ALAND"] / 1_000_000, 3)

        land_geometry = display_geometry[geoid]
        alternate_coverage = pct_covered(project(land_geometry), buffer_parts, buffer_index)
        sensitivity_changes += (alternate_coverage >= COVERAGE_THRESHOLD) != props["railNear"]

        lng, lat = float(record["INTPTLON"]), float(record["INTPTLAT"])
        point = Point(lng, lat)
        if not land_geometry.covers(point):
            point = land_geometry.representative_point()
        props["lng"], props["lat"] = round(point.x, 6), round(point.y, 6)
        metric_point = project(point)
        nearest = station_index.nearest(metric_point)
        props["nearestStation"] = station_values[nearest]["name"]
        props["stationMeters"] = round(metric_point.distance(station_points[nearest]))
        tracts.append(feature(land_geometry, props, geoid))

    assert len(tracts) == len(display_geometry) == 2495
    assert len(estimates) - len(tracts) == 3
    buffers = [feature(unproject(part), {"meters": BUFFER_METERS}) for part in buffer_parts]
    rings = [
        feature(
            unproject(LineString(buffer.exterior.coords)),
            {"meters": BUFFER_METERS, "name": station["name"]},
            station_id,
        )
        for (station_id, station), buffer in zip(stations.items(), station_buffers)
    ]
    return sorted(tracts, key=lambda feature: feature["id"]), buffers, rings, sensitivity_changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("reproduce/housing-cache"))
    parser.add_argument("--output", type=Path, default=Path("data"))
    args = parser.parse_args()

    cache_sources(args.cache)
    args.output.mkdir(parents=True, exist_ok=True)
    estimates, rent_threshold, burden_threshold = housing_estimates(args.cache)
    stations, rail = read_rail_feed(args.cache / "rail.zip")
    tracts, buffers, rings, sensitivity_changes = tract_layers(
        args.cache, estimates, rent_threshold, burden_threshold, stations
    )

    save_features(args.output / "tracts.geojson", tracts)
    save_features(args.output / "stations.geojson", [
        feature(station["geometry"], {"name": station["name"], "lines": station["lines"]}, station_id)
        for station_id, station in stations.items()
    ])
    save_features(args.output / "rail.geojson", rail)
    save_features(args.output / "buffers.geojson", buffers)
    save_features(args.output / "rings.geojson", rings)

    places = shapefile.Reader(str(args.cache / "places.zip"))
    city = next(sr for sr in places.iterShapeRecords() if sr.record["GEOID"] == "0644000")
    city_polygon = polygonal(shape(city.shape.__geo_interface__))
    save_features(args.output / "city.geojson", [
        feature(city_polygon, {"name": "City of Los Angeles"}, "0644000")
    ])

    counts = Counter(feature["properties"]["quadrant"] for feature in tracts)
    near_counts = Counter(
        feature["properties"]["quadrant"] for feature in tracts if feature["properties"]["railNear"]
    )
    summary = {
        "tractCount": len(tracts),
        "classifiedCount": len(tracts) - counts["no-data"],
        "waterOnlyTractsOmitted": 3,
        "thresholds": {
            "rent": rent_threshold,
            "burden": burden_threshold,
            "bufferMeters": BUFFER_METERS,
            "railCoverage": COVERAGE_THRESHOLD,
        },
        "counts": dict(counts),
        "nearCounts": {key: near_counts[key] for key in counts},
        "railNearCount": sum(near_counts.values()),
        "railGeometrySensitivityChangedTracts": sensitivity_changes,
        "stationCount": len(stations),
        "railFeedDate": FEED_DATE,
        "railFeedCommit": FEED_COMMIT,
        "comparison": ["06037234600", "06037269909"],
    }
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Wrote {len(tracts):,} tracts, {len(rail)} rail lines and {len(stations)} stations to {args.output}.")


if __name__ == "__main__":
    main()
