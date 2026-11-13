#!/usr/bin/env python3
"""Prepare the atlas's offline reference geography.

Requires geopandas, mapbox-vector-tile, requests and Shapely.
From the atlas folder: python reproduce/prepare_context.py --cache /tmp/la-atlas-context
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import json
from math import asinh, atan, floor, pi, radians, sinh, tan
from pathlib import Path

import geopandas
import mapbox_vector_tile
import requests
from shapely import get_parts, line_merge, make_valid, set_precision, union_all
from shapely.geometry import MultiLineString, box, mapping, shape

CENSUS = "https://www2.census.gov/geo/tiger/GENZ2025/shp"
OPENFREEMAP = "https://tiles.openfreemap.org/planet/20261101_080013_pt"
BOUNDS = (-119.42, 32.95, -117.05, 35.18)
DETAIL_BOUNDS = (-118.72, 33.69, -118.01, 34.37)
AREA = box(*BOUNDS)
DETAIL = box(*DETAIL_BOUNDS)
CITY_MINZOOM = {
    "Los Angeles": 7, "Long Beach": 8, "Pasadena": 8, "Santa Monica": 8,
    "Malibu": 8, "Santa Clarita": 8, "Palmdale": 8, "Lancaster": 8,
    "Oxnard": 8, "Thousand Oaks": 8, "Anaheim": 8, "Santa Ana": 8,
    "San Bernardino": 8, "Riverside": 8, "Irvine": 8,
    "Glendale": 9, "Inglewood": 9, "Burbank": 9, "Torrance": 9,
    "Pomona": 9, "West Covina": 9, "Downey": 9, "Redondo Beach": 9,
    "El Monte": 9, "San Pedro": 9, "Avalon": 9, "Simi Valley": 9,
    "Hollywood": 10, "Van Nuys": 10, "North Hollywood": 10,
    "Koreatown": 10, "East Los Angeles": 10, "Boyle Heights": 10,
    "Downtown Los Angeles": 10, "Westwood": 10, "South Los Angeles": 10,
    "Culver City": 10, "Compton": 10, "Watts": 11, "Wilmington": 11,
    "Exposition Park": 11, "Leimert Park": 11, "West Adams": 11,
}
POLYGON_TYPES = ("Polygon", "MultiPolygon")
LINE_TYPES = ("LineString", "MultiLineString")


def download(url, path):
    if not path.exists():
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        path.write_bytes(response.content)
    return path


def tile_coordinates(lon, lat, zoom):
    size = 2 ** zoom
    return floor((lon + 180) / 360 * size), floor((1 - asinh(tan(radians(lat))) / pi) / 2 * size)


def inverse_project(zoom, x, y):
    size = 2 ** zoom
    return x / size * 360 - 180, atan(sinh(pi * (1 - 2 * y / size))) * 180 / pi


def tile_bounds(zoom, x, y):
    west, north = inverse_project(zoom, x, y)
    east, south = inverse_project(zoom, x + 1, y + 1)
    return box(west, south, east, north)


def tile_grid(bounds, zoom):
    west, south, east, north = bounds
    x1, y1 = tile_coordinates(west, north, zoom)
    x2, y2 = tile_coordinates(east, south, zoom)
    return [(zoom, x, y) for x in range(x1, x2 + 1) for y in range(y1, y2 + 1)]


def project_geometry(geometry, zoom, x, y, extent):
    def transform(coords, dimensions):
        if dimensions == 1:
            return inverse_project(zoom, x + coords[0] / extent, y + coords[1] / extent)
        return [transform(sequence, dimensions - 1) for sequence in coords]
    dimensions = {
        "Point": 1, "MultiPoint": 2, "LineString": 2, "MultiLineString": 3,
        "Polygon": 3, "MultiPolygon": 4,
    }
    kind = geometry["type"]
    if kind in dimensions:
        return shape({
            "type": kind,
            "coordinates": transform(geometry["coordinates"], dimensions[kind]),
        })
    return None


def geometry_parts(geometry, kinds):
    if geometry.is_empty:
        return
    if geometry.geom_type in kinds:
        yield geometry
    elif geometry.geom_type == "GeometryCollection":
        for part in get_parts(geometry):
            yield from geometry_parts(part, kinds)


def feature(kind, geometry, **properties):
    geometry = set_precision(geometry, 0.00001)
    return {
        "type": "Feature",
        "properties": {"kind": kind, **properties},
        "geometry": mapping(geometry),
    }


def census_features(cache):
    counties_zip = download(f"{CENSUS}/cb_2025_us_county_500k.zip", cache / "counties.zip")
    places_zip = download(f"{CENSUS}/cb_2025_06_place_500k.zip", cache / "places.zip")
    counties = geopandas.read_file(counties_zip).to_crs(4326)
    places = geopandas.read_file(places_zip).to_crs(4326)
    region = counties.loc[(counties["STATEFP"] == "06") & counties.intersects(AREA)]
    land = union_all(region.geometry.values).intersection(AREA).simplify(0.00018)
    county = region.loc[region["GEOID"] == "06037", "geometry"].iloc[0].simplify(0.00015)
    city = places.loc[places["GEOID"] == "0644000", "geometry"].iloc[0].simplify(0.00012)
    return [
        feature("land", land),
        feature("coast", land.boundary.difference(AREA.boundary.buffer(0.00002))),
        feature("county", county.boundary, name="Los Angeles County"),
        feature("city", city.boundary, name="City of Los Angeles"),
    ]


def tile_features(cache, tile):
    z, x, y = tile
    path = download(f"{OPENFREEMAP}/{z}/{x}/{y}.pbf", cache / f"{z}-{x}-{y}.pbf")
    clip = tile_bounds(z, x, y).intersection(DETAIL if z == 12 else AREA)
    if clip.is_empty:
        return [], []
    data = mapbox_vector_tile.decode(path.read_bytes(), default_options={"y_coord_down": True})
    features = []
    labels = []
    lines = defaultdict(list)
    for layer_name in ("park", "landcover", "transportation", "water", "place"):
        if layer_name not in data:
            continue
        layer = data[layer_name]
        for raw in layer["features"]:
            props = raw["properties"]
            classification = props.get("class")
            name = props.get("name:en") or props.get("name_en") or props.get("name")
            geom_type = raw["geometry"]["type"]
            if layer_name == "place":
                if name not in CITY_MINZOOM and (classification != "city" or props.get("rank", 99) > 12):
                    continue
                minzoom = CITY_MINZOOM.get(name, 10)
                if geom_type != "Point":
                    continue
                geometry = project_geometry(raw["geometry"], z, x, y, layer["extent"])
                if clip.covers(geometry):
                    labels.append((name, minzoom, props.get("rank", 99), geometry))
                continue
            if layer_name == "transportation":
                if geom_type not in LINE_TYPES or props.get("ramp") == 1 or props.get("brunnel") == "tunnel":
                    continue
                if z == 10 and classification in ("motorway", "trunk"):
                    kind, minzoom = "highway", 8
                elif z == 10 and classification in ("primary", "secondary"):
                    kind, minzoom = "road", 10
                elif z == 12 and classification == "tertiary":
                    kind, minzoom = "road", 12
                else:
                    continue
                kinds, minimum_size = LINE_TYPES, 0.0008 if z == 12 else 0.0005
            else:
                if geom_type not in POLYGON_TYPES:
                    continue
                if layer_name == "water":
                    if z != 10 or classification not in ("lake", "river"):
                        continue
                    kind, minzoom = "water", 9
                else:
                    if layer_name == "park" and classification == "historic":
                        continue
                    if layer_name == "landcover" and classification != "wood" and props.get("subclass") != "park":
                        continue
                    kind, minzoom = "park", 8
                kinds, minimum_size = POLYGON_TYPES, 0.000018 if z == 12 else 0.000035
            geometry = project_geometry(raw["geometry"], z, x, y, layer["extent"])
            if geometry is None:
                continue
            if not geometry.is_valid:
                geometry = make_valid(geometry)
            if kind == "park" and z == 12 and geometry.area >= 0.00015:
                continue
            geometry = geometry.intersection(clip).simplify(0.00010 if z == 12 else 0.00020)
            for part in geometry_parts(geometry, kinds):
                size = part.length if kinds == LINE_TYPES else part.area
                if size < minimum_size:
                    continue
                if kinds == LINE_TYPES:
                    lines[(kind, minzoom)].extend(get_parts(part))
                else:
                    features.append(feature(kind, part, minzoom=minzoom))
    for (kind, minzoom), parts in lines.items():
        merged = line_merge(MultiLineString(parts))
        features.append(feature(kind, merged, minzoom=minzoom))
    return features, labels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/context.geojson"))
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    features = census_features(args.cache)
    tiles = tile_grid(BOUNDS, 10) + tile_grid(DETAIL_BOUNDS, 12)
    labels = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        for batch, places in executor.map(lambda tile: tile_features(args.cache, tile), tiles):
            features.extend(batch)
            for name, minzoom, rank, point in places:
                if name not in labels or rank < labels[name][1]:
                    labels[name] = (minzoom, rank, point)
    for name, (minzoom, rank, point) in sorted(labels.items(), key=lambda pair: pair[1][:2]):
        features.append(feature("place", point, name=name, minzoom=minzoom, rank=rank))
    args.output.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": features,
    }, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{args.output}: {args.output.stat().st_size:,} bytes. {dict(Counter(f['properties']['kind'] for f in features))}")


if __name__ == "__main__":
    main()
