#!/usr/bin/env python3
"""Build the renter cost-burden / vehicle-availability map.

From the atlas directory, with Python 3 and shapely >= 2:
    python reproduce/prepare_renter_vehicles.py --cache path/to/cache

This reads the bundled tract membership, tract display boundaries and LA city
outline, then downloads the two national 2019–2023 ACS 5-year summary tables.
To re-extract membership from the original QGIS map, also install pypdf,
geopandas, pyogrio and pyproj, and add --original-map path/to/Map1.pdf.
"""

import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
from statistics import quantiles
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

from shapely import intersection, make_valid, union_all
from shapely.geometry import mapping, shape


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
COHORT = DATA / "historical-city-tracts.csv"
ACS = "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/data/5YRData"
TIGER = "https://www2.census.gov/geo/tiger/TIGER2023/TRACT/tl_2023_06_tract.zip"
CARTO = "https://www2.census.gov/geo/tiger/GENZ2023/shp"
ORIGINAL_CLASSES = {25: "lower-burden-lower-rail", 27: "high-burden-lower-rail",
                    28: "lower-burden-greater-rail", 29: "high-burden-greater-rail", 30: "no-burden-data"}
EXPECTED_ORIGINAL = {25: 680, 27: 235, 28: 144, 29: 40, 30: 9}
CATEGORIES = ("both", "burden", "vehicle", "neither", "no-data")


def source(cache, filename, url):
    target = cache / filename
    if not target.exists():
        with NamedTemporaryFile(dir=cache, delete=False) as output:
            temp = Path(output.name)
        try:
            with urlopen(url, timeout=120) as response, temp.open("wb") as output:
                shutil.copyfileobj(response, output)
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)
    return target


def recover_membership(pdf, tract_path):
    """Match exact vector polygon interiors in this specific georeferenced QGIS export."""
    import geopandas as gpd
    from pypdf import PdfReader
    from pyproj import Transformer
    from shapely import STRtree
    from shapely.geometry import Polygon

    expected_pdf = "dc234e1665770eb8ec595728e63c287e3c5ff7c59d7ab210670bdfb45d5a2ed5"
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != expected_pdf:
        raise ValueError("Provide the original, unmodified Housing Pressure and Rail Proximity PDF.")
    tracts = gpd.read_file(tract_path, where="COUNTYFP = '037'", columns=["COUNTYFP", "GEOID"]).to_crs(26911)
    tree = STRtree(tracts.geometry)
    page = PdfReader(pdf).pages[0]
    measure = page["/VP"][0].get_object()["/Measure"]
    if measure["/GCS"]["/EPSG"] != 26911:
        raise ValueError("Unexpected original map projection.")
    points = list(map(float, measure["/GPTS"]))
    project = Transformer.from_crs(4326, 26911, always_xy=True)
    east, north = project.transform(points[1::2], points[::2])
    left, right = sum(east[:2])/2, sum(east[2:])/2
    top, bottom = (north[0]+north[3])/2, (north[1]+north[2])/2
    # The page-level PDF transform scales the 3300 x 5100 QGIS coordinate
    # canvas into the 792 x 1224 pt full-page map viewport.
    contents = page["/Contents"].get_object().get_data().decode("latin-1")
    fills = contents.split("q\n/CSp cs\n1 1 1 scn\n/GState26 gs")[:-1]
    ids = {}
    states = []
    for block in fills:
        lines = block.splitlines()
        if lines.pop() != "f*":
            raise ValueError("Expected a closed, even-odd tract fill immediately before its outline.")
        rings, ring = [], []
        while lines:
            op = lines[-1]
            if op == "h":
                if ring:
                    rings.append(ring)
                    ring = []
            elif op.endswith((" m", " l")):
                x, y, _ = op.split()
                ring.append((left + float(x)*(right-left)/3300, top + float(y)*(bottom-top)/5100))
            else:
                break
            lines.pop()
        if ring:
            rings.append(ring)
        states.extend(int(m[1]) for op in lines if (m := re.fullmatch(r"/GState(25|27|28|29|30) gs", op)))
        outline = max((make_valid(Polygon(r)) for r in rings if len(r) >= 3), key=lambda g: g.area)
        matches = tree.query(outline.representative_point(), predicate="within")
        if len(matches) != 1:
            raise ValueError("Original map fill does not identify exactly one Census tract.")
        record = tracts.iloc[matches[0]]
        overlap = outline.intersection(record.geometry).area / outline.area
        if overlap < 0.9999 or record.GEOID in ids:
            raise ValueError(f"Ambiguous original map fill for {record.GEOID}: {overlap:.6%}")
        ids[record.GEOID] = states[-1]
    if Counter(ids.values()) != EXPECTED_ORIGINAL:
        raise ValueError("Recovered counts do not match all five categories of the original map.")
    return {key: ORIGINAL_CLASSES[value] for key, value in sorted(ids.items())}


def read_acs(cache, table, ids):
    name = f"acsdt5y2023-{table.lower()}.dat"
    filename = source(cache, name, f"{ACS}/{name}")
    with filename.open(encoding="utf-8-sig") as f:
        rows = {row["GEO_ID"][-11:]: row for row in csv.DictReader(f, delimiter="|")
                if row["GEO_ID"].startswith("1400000US") and row["GEO_ID"][-11:] in ids}
    if rows.keys() != ids.keys():
        raise ValueError(f"Missing study tract in {name}")
    return rows


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def build(ids, cache):
    housing = read_acs(cache, "B25070", ids)
    vehicles = read_acs(cache, "B25044", ids)
    city = shape(json.loads((DATA / "city.geojson").read_text())["features"][0]["geometry"])
    basemap = json.loads((DATA / "tracts.geojson").read_text())["features"]
    features = []
    for tract in basemap:
        p = tract["properties"]
        gid = p["geoid"]
        if gid not in ids:
            continue
        h, v = housing[gid], vehicles[gid]
        burden_n = int(h["B25070_E001"]) - int(h["B25070_E011"])
        burdened = sum(int(h[f"B25070_E{i:03}"]) for i in (7, 8, 9, 10))
        renters, no_car = int(v["B25044_E009"]), int(v["B25044_E010"])
        if not 0 <= burdened <= burden_n or not 0 <= no_car <= renters:
            raise ValueError(f"Invalid source counts for {gid}")
        counts = {"geoid": gid, "tract": p["tract"], "burdened": burdened, "burdenN": burden_n,
                  "noVehicleRenters": no_car, "renters": renters,
                  "burden": 100*burdened/burden_n if burden_n else None,
                  "zeroVehicle": 100*no_car/renters if renters else None}
        # Limit display to the city. Keep original whole-tract ACS counts above.
        cut = intersection(make_valid(shape(tract["geometry"])), city, grid_size=.000001)
        area = union_all(list(polygon_parts(cut)))
        if area.is_empty:
            raise ValueError(f"Tract {gid} lost its display geometry")
        geo = json.loads(json.dumps(mapping(area)), parse_float=lambda v: round(float(v), 6))
        features.append({"type": "Feature", "id": gid, "properties": counts, "geometry": geo})
    if {f["id"] for f in features} != ids.keys():
        raise ValueError("Incomplete display geography.")
    features.sort(key=lambda f: f["id"])
    values = [f["properties"] for f in features]
    burden_rates = [v["burden"] for v in values if v["burden"] is not None]
    vehicle_rates = [v["zeroVehicle"] for v in values if v["zeroVehicle"] is not None]
    # Inclusive quantiles linearly interpolate at p*(n-1), p=.75.
    b_cut = quantiles(burden_rates, n=4, method="inclusive")[2]
    v_cut = quantiles(vehicle_rates, n=4, method="inclusive")[2]
    for p in values:
        b, v, gid = p["burden"], p["zeroVehicle"], p["geoid"]
        bh = b is not None and b >= b_cut
        if bh != ids[gid].startswith("high-burden") or (b is None) != (ids[gid] == "no-burden-data"):
            raise ValueError(f"Recalculated burden differs from original map for {gid}")
        vh = v is not None and v >= v_cut
        p["category"] = ("no-data" if b is None or v is None else
                         "both" if bh and vh else "burden" if bh else "vehicle" if vh else "neither")
        for key in ("burden", "zeroVehicle"):
            if p[key] is not None:
                p[key] = round(p[key], 6)
    count = Counter(v["category"] for v in values)
    lesser = [v for v in values if ids[v["geoid"]] == "high-burden-lower-rail"]
    rail = {"both": sum(v["category"] == "both" for v in lesser),
            "valid": sum(v["zeroVehicle"] is not None for v in lesser), "total": len(lesser)}
    meta = {
        "burdenThreshold": b_cut, "vehicleThreshold": v_cut, "counts": {k: count[k] for k in CATEGORIES},
        "tractCount": len(features), "validBurden": len(burden_rates), "validVehicle": len(vehicle_rates),
        "validBoth": len(features)-count["no-data"], "lowerRail": rail,
        "scope": "The 1,108 City of Los Angeles study tracts from Housing Pressure and Rail Proximity.",
        "methods": [
            "Study area. Each tract polygon in the georeferenced Housing Pressure and Rail Proximity map was matched to its 2023 Census tract. All 1,108 GEOIDs and all five class counts were recovered. City clipping affects display only. ACS estimates use each whole tract.",
            "Rent burden. The numerator counts renter households paying at least 30% of household income in gross rent (B25070 lines 7–10). The denominator includes cash-rent households with a computable rent-to-income ratio (line 1 minus line 11).",
            "Vehicle availability. B25044 line 10 counts renter households reporting no vehicle available. The denominator is all renter households (line 9). The two shares come from separate ACS tables and describe area-level patterns.",
            "Thresholds. Each measure uses the inclusive 75th percentile of valid whole-tract estimates within the study area. Values at or above the unrounded threshold enter the high group. A tract needs two computable rates for a two-variable classification. ACS estimates carry sampling uncertainty.",
        ],
        "sources": [
            {"name": "ACS 2019–2023 · B25070 rent burden", "url": "https://api.census.gov/data/2023/acs/acs5/groups/B25070.html"},
            {"name": "ACS 2019–2023 · B25044 vehicle availability", "url": "https://api.census.gov/data/2023/acs/acs5/groups/B25044.html"},
            {"name": "2023 Census TIGER/Line tracts · original map registration", "url": TIGER},
            {"name": "2023 Census cartographic tract boundaries · display", "url": f"{CARTO}/cb_2023_06_tract_500k.zip"},
            {"name": "2023 Census place boundaries · LA display extent", "url": f"{CARTO}/cb_2023_06_place_500k.zip"},
            {"name": "Original map study tracts and five classes (CSV)", "url": "./data/historical-city-tracts.csv"},
        ]
    }
    return {"type": "FeatureCollection", "meta": meta, "features": features}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--original-map", type=Path)
    parser.add_argument("--output", type=Path, default=DATA/"renter-vehicles.json")
    args = parser.parse_args()
    args.cache.mkdir(exist_ok=True, parents=True)
    if args.original_map:
        ids = recover_membership(args.original_map, source(args.cache, "tiger-tracts.zip", TIGER))
        with COHORT.open("w", newline="") as f:
            writer = csv.writer(f, lineterminator="\n")
            writer.writerow(("geoid", "original_class"))
            writer.writerows(ids.items())
    else:
        with COHORT.open() as f:
            ids = {row["geoid"]: row["original_class"] for row in csv.DictReader(f)}
    data = build(ids, args.cache)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"))+"\n")
    print(f"{len(data['features'])} tracts: {data['meta']['counts']}")


if __name__ == "__main__":
    main()
