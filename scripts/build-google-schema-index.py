"""Builds inventory/google-ads-<version>-schema.json from Google's REST discovery document.

Usage: python3 scripts/build-google-schema-index.py <discovery.json> <version>
Download: https://googleads.googleapis.com/$discovery/rest?version=v26

The index holds, for every schema, its property names with type / $ref / enum values. Tests use it to check that GAQL
field names and mutate request bodies exist in the configured API version, so field names are verified, not guessed.
"""
import json, re, sys

src, version = sys.argv[1], sys.argv[2]
d = json.load(open(src))
prefix = f"GoogleAdsGoogleadsV{version.lstrip('v')}"
out = {}
for name, sch in d["schemas"].items():
    if not name.startswith(prefix):
        continue
    short = name[len(prefix):]  # e.g. "Resources__Campaign"
    props = {}
    for p, v in (sch.get("properties") or {}).items():
        e = {}
        t = v
        if v.get("type") == "array":
            e["array"] = True
            t = v.get("items", {})
        if "$ref" in t:
            e["ref"] = t["$ref"][len(prefix):] if t["$ref"].startswith(prefix) else t["$ref"]
        else:
            e["type"] = t.get("type", "any")
            if t.get("enum"):
                e["enum"] = t["enum"]
            if t.get("format"):
                e["format"] = t["format"]
        props[p] = e
    out[short] = props
json.dump({"version": version, "source": "https://googleads.googleapis.com/$discovery/rest?version=" + version, "schemas": out}, open(f"inventory/google-ads-{version}-schema.json", "w"), separators=(",", ":"), sort_keys=True)
print(len(out), "schemas")
