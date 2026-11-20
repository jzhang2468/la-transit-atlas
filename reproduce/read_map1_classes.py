#!/usr/bin/env python3
"""Read the two high-burden tract classes on the author's georeferenced QGIS Map 1.

From the atlas directory, provide the original October 2026 PDF:
  python reproduce/read_map1_classes.py "01_Housing_Pressure_and_Rail (1).pdf"

The other inputs default to data/tracts.geojson and the output defaults to
data/historical-rail-screen.csv. Use --tracts and --output to change them.
Requires pdftoppm on PATH, and Python with pypdf, numpy, Pillow, pyproj,
rasterio and shapely. Geometry must be WGS84 GeoJSON with GEOID or geoid.

Pink means high rent burden with lower historical rail proximity. Red means
high burden with greater proximity. Both classes use 2019–23 ACS B25070.
Map 1 reports a top-quartile burden threshold of 67.53%, and defines greater
rail proximity as at least 50% of original tract area within 800 m of its
end-of-2023 station layer. The CSV recovers the published classification
from polygon fills. Fraction columns measure color agreement, not rail area.

The map's full-page viewport supplies the geospatial registration in EPSG:26911.
The 160 dpi rendering is about 32 m per pixel. To reduce mixed edge colors,
sample each tract at least 35 m inside its perimeter where possible. Widened
color ranges accommodate the basemap visible beneath semi-transparent fills.
Roads, annotations and symbols may cover parts of a tract. The bundled map
classes were also checked against the county's separate 2,498-tract download
from https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2023/MapServer/8
and both geometry sources yielded exactly the same 235 pink and 40 red GEOIDs.
"""

import argparse
import csv
import json
import subprocess
from collections import Counter
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image
from pypdf import PdfReader
from pyproj import Transformer
from rasterio import Affine
from rasterio.features import rasterize
from shapely.geometry import shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[1]
TO_UTM = Transformer.from_crs(4326, 26911, always_xy=True)
EXPECTED = {"pink": 235, "red": 40}


def pixel_transform(pdf, width, height):
    page = PdfReader(pdf).pages[0]
    viewport = page["/VP"][0].get_object()
    measure = viewport["/Measure"]
    if list(viewport["/BBox"]) != list(page.mediabox) or measure["/GCS"]["/EPSG"] != 26911:
        raise ValueError("Expected the full-page EPSG:26911 viewport in original Map 1")
    corners = np.array(measure["/LPTS"], dtype=float).reshape(-1, 2)
    positions = np.array(measure["/GPTS"], dtype=float).reshape(-1, 2)
    x, y = TO_UTM.transform(positions[:, 1], positions[:, 0])
    # Local PDF coordinates use bottom-left as origin. Raster rows start at the top.
    left, right = x[corners[:, 0] == 0], x[corners[:, 0] == 1]
    bottom, top = y[corners[:, 1] == 0], y[corners[:, 1] == 1]
    for edge in (left, right, bottom, top):
        if len(edge) != 2 or np.ptp(edge) > 1:
            raise ValueError("Map 1 viewport should have four axis-aligned UTM corners")
    return Affine.translation(left.mean(), top.mean()) * Affine.scale(
        (right.mean() - left.mean()) / width, (bottom.mean() - top.mean()) / height
    )


def identify_tracts(pdf, tracts):
    with TemporaryDirectory() as directory:
        prefix = Path(directory) / "map1"
        subprocess.run(["pdftoppm", "-f", "1", "-l", "1", "-r", "160", "-png",
                        "-singlefile", str(pdf), str(prefix)], check=True)
        with Image.open(prefix.with_suffix(".png")) as image:
            rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    height, width = rgb.shape[:2]
    geo_transform = pixel_transform(pdf, width, height)
    features = json.loads(tracts.read_text())["features"]
    shapes = []
    geoids = []
    for index, feature in enumerate(features, start=1):
        geometry = transform(TO_UTM.transform, shape(feature["geometry"]))
        interior = geometry.buffer(-35)
        shapes.append((geometry if interior.is_empty else interior, index))
        properties = feature["properties"]
        geoids.append(properties.get("geoid") or properties["GEOID"])
    indexes = rasterize(shapes, out_shape=(height, width), transform=geo_transform,
                        fill=0, dtype="uint16").ravel()
    r, g, b = rgb.reshape(-1, 3).T
    pink = (r - g >= 13) & (r - g <= 52) & (b >= g) & (r - b >= 10)
    red = (r - g >= 65) & (r - b >= 60)
    counts = np.bincount(indexes, minlength=len(geoids) + 1)
    def fractions(mask):
        return np.bincount(indexes, weights=mask, minlength=len(counts)) / np.maximum(1, counts)
    pink_share, red_share = fractions(pink), fractions(red)
    rows = []
    for i, geoid in enumerate(geoids, start=1):
        if max(pink_share[i], red_share[i]) >= 0.25:
            rows.append({"geoid": geoid, "category": "pink" if pink_share[i] > red_share[i] else "red",
                         "pink_fraction": round(pink_share[i], 4), "red_fraction": round(red_share[i], 4),
                         "pixels": int(counts[i])})
    for threshold in (0.25, 0.50, 0.65):
        observed = Counter(row["category"] for row in rows
                           if max(row["pink_fraction"], row["red_fraction"]) >= threshold)
        if observed != EXPECTED:
            raise ValueError(f"At {threshold:.0%} fill share, {dict(observed)} differs from Map 1 legend {EXPECTED}")
    return sorted(rows, key=lambda row: row["geoid"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--tracts", type=Path, default=ROOT / "data/tracts.geojson")
    parser.add_argument("--output", type=Path, default=ROOT / "data/historical-rail-screen.csv")
    args = parser.parse_args()
    rows = identify_tracts(args.pdf, args.tracts)
    with args.output.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} high-burden tracts to {args.output}; recovered both Map 1 legend counts.")


if __name__ == "__main__":
    main()
