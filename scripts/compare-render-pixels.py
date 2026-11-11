"""Local, exact pixel comparison for same-machine renderer refactors."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

before, after, output = map(Path, sys.argv[1:])
a = Image.open(before).convert("RGBA")
b = Image.open(after).convert("RGBA")
if a.size != b.size:
    print(json.dumps({"error": "size changed", "before": a.size, "after": b.size}))
    sys.exit(1)
diff = ImageChops.difference(a, b)
# RGBA.getbbox() considers alpha; screenshot alpha is opaque in both images.
rgb = diff.convert("RGB")
bbox = rgb.getbbox()
if bbox:
    output.parent.mkdir(parents=True, exist_ok=True)
    rgb.save(output)
    count = sum(pixel != (0, 0, 0) for pixel in rgb.getdata())
    print(json.dumps({"changedPixels": count, "bounds": bbox, "diff": str(output)}))
    sys.exit(1)
print(json.dumps({"changedPixels": 0}))
