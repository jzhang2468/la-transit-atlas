#!/usr/bin/env python3
"""Aggregate 2024 Census LODES primary jobs from block pairs to LA County tract pairs.

Get ca_od_main_JT01_2024.csv.gz from:
https://lehd.ces.census.gov/data/lodes/LODES8/ca/od/ca_od_main_JT01_2024.csv.gz

Run from the project folder:
  python3 reproduce/prepare_commute.py ca_od_main_JT01_2024.csv.gz

Data dictionary:
https://lehd.ces.census.gov/data/lodes/LODES8/LODESTechDoc8.5.pdf
"""

import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path


LA_COUNTY = b"06037"
SOURCE_CHECKSUM = "cb37af72c364c88c3594e396864371550a8cc843924dbc63365c04bfb4f782fc"
TOP_DESTINATIONS = 12


def build_origins(source):
    california_jobs = Counter()
    workplace_tracts = defaultdict(Counter)
    source_hash = hashlib.sha256()

    with gzip.open(source, "rb") as rows:
        header = next(rows)
        source_hash.update(header)
        if header.split(b",")[:3] != [b"w_geocode", b"h_geocode", b"S000"]:
            raise ValueError("Expected workplace block, home block, and jobs as the first three fields.")

        for row in rows:
            source_hash.update(row)
            # w_geocode has 15 characters, followed by the comma and h_geocode.
            if row[16:21] != LA_COUNTY:
                continue
            workplace, home, count, _ = row.split(b",", 3)
            home_tract = home[:11]
            jobs = int(count)
            california_jobs[home_tract] += jobs
            if workplace.startswith(LA_COUNTY):
                workplace_tracts[home_tract][workplace[:11]] += jobs

    if source_hash.hexdigest() != SOURCE_CHECKSUM:
        raise ValueError("The uncompressed file differs from the Census Bureau's published checksum.")

    origins = {}
    for home, total in sorted(california_jobs.items()):
        destinations = workplace_tracts[home]
        # Use tract GEOID as the tie-breaker to make ranking repeatable.
        ranked = sorted(destinations.items(), key=lambda item: (-item[1], item[0]))
        origins[home.decode("ascii")] = {
            "californiaJobs": total,
            "losAngelesJobs": sum(destinations.values()),
            "destinations": [[tract.decode("ascii"), jobs] for tract, jobs in ranked[:TOP_DESTINATIONS]],
        }
    return origins


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="California 2024 main JT01 CSV gzip")
    parser.add_argument("--output", type=Path, default=Path("data/commute.json"))
    args = parser.parse_args()
    origins = build_origins(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as output:
        json.dump({"year": 2024, "origins": origins}, output, separators=(",", ":"))
        output.write("\n")
    print(f"Wrote {len(origins):,} origins to {args.output}")


if __name__ == "__main__":
    main()
