"""Study area, paths and identity. Everything location-specific lives here."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # ~/ballard-live
LAKE = Path(os.environ.get("BO_LAKE", ROOT / "lake"))
OUT = Path(os.environ.get("BO_OUT", ROOT / "lake" / "_out"))  # engine outputs (insights, places, series)
USER_AGENT = "BallardObservatory/0.1 (+https://github.com/; public-records research; contact via repo issues)"

# Greater Ballard: north of the Ship Canal, west of ~3rd Ave NW, south of ~NW 90th St (Ballard, Sunset Hill,
# Loyal Heights, Whittier Heights, Adams, West Woodland, and the Crown Hill edge). Records outside are not kept,
# except citywide daily aggregates used as comparison baselines.
BBOX = {"south": 47.655, "north": 47.700, "west": -122.415, "east": -122.355}
ZIPS = ("98107", "98117")
SPD_NEIGHBORHOODS = ("BALLARD NORTH", "BALLARD SOUTH")
SPD_BEATS = ("B1", "B2", "B3")
CENTER = (47.6687, -122.3847)                        # NW Market St & Ballard Ave NW
TZ = "America/Los_Angeles"


def in_bbox(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lon <= BBOX["east"]
