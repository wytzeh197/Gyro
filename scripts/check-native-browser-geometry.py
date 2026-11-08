"""Compare debug-fixture PNG coordinates to independently observed DOM geometry."""
import json
import sys
import math
from pathlib import Path

from PIL import Image, ImageChops


report_path = Path(sys.argv[1])
report = json.loads(report_path.read_text())
cases = []
for observation in report["observations"]:
    if "capture" not in observation or "requested" not in observation:
        continue
    capture = observation["capture"]
    document = observation["documentAfter"]
    marker = document["marker"]
    with Image.open(capture["path"]) as source:
        bitmap = source.convert("RGB")
    red, green, blue = bitmap.split()
    mask = ImageChops.multiply(
        ImageChops.multiply(
            red.point(lambda value: 255 if value >= 240 else 0),
            blue.point(lambda value: 255 if value >= 240 else 0),
        ),
        green.point(lambda value: 255 if value <= 15 else 0),
    )
    bounds = mask.getbbox()
    scale_x = bitmap.width / document["width"]
    scale_y = bitmap.height / document["height"]
    expected = [
        marker["x"] * scale_x,
        marker["y"] * scale_y,
        (marker["x"] + marker["width"]) * scale_x,
        (marker["y"] + marker["height"]) * scale_y,
    ]
    native = observation["nativeAfter"]
    # A fitted view is painted on its native backing grid before the snapshot
    # is returned at CSS width. Allow one backing pixel at a rasterized edge;
    # the independently sampled target centre must still match at CSS coordinates.
    edge_tolerance = max(1, 1 / (native["zoom"] * native["backingScale"]))
    centre = (
        math.floor((marker["x"] + marker["width"] / 2) * scale_x),
        math.floor((marker["y"] + marker["height"] / 2) * scale_y),
    )
    centre_colour = bitmap.getpixel(centre)
    checks = {
        "decodedPngMatchesCaptureMetadata": bitmap.size == (capture["width"], capture["height"]),
        "decodedPngMatchesDomViewport": bitmap.size == (document["width"], document["height"]),
        "decodedPngMatchesRequestedViewport": bitmap.size == (observation["requested"]["width"], observation["requested"]["height"]),
        "markerCentreMatchesDom": centre_colour[0] > centre_colour[1] + 60
        and centre_colour[2] > centre_colour[1] + 60,
        "markerEdgesWithinOneBackingPixel": bounds is not None
        and all(abs(actual - target) <= edge_tolerance for actual, target in zip(bounds, expected)),
    }
    cases.append({
        "case": observation["case"],
        "passed": all(checks.values()),
        "checks": checks,
        "png": capture["path"],
        "size": bitmap.size,
        "markerPixels": bounds,
        "expectedMarkerPixels": expected,
        "rasterEdgeToleranceCss": edge_tolerance,
        "markerCentre": centre,
        "markerCentreColour": centre_colour,
    })
result = {
    "passed": bool(cases) and report["passed"] and all(case["passed"] for case in cases),
    "nativePassed": report["passed"],
    "cases": cases,
}
output = report_path.with_name("browser-geometry-pixels.json")
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"passed": result["passed"], "cases": len(cases), "report": str(output)}))
sys.exit(0 if result["passed"] else 1)
