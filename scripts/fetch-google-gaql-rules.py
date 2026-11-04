"""Records GAQL selection rules from Google's field reference pages into inventory/google-ads-<version>-gaql.json.

Usage: python3 scripts/fetch-google-gaql-rules.py v26 campaign ad_group ...
Source pages: https://developers.google.com/google-ads/api/fields/<version>/<resource>

For each resource: the attributed resources (whose fields may be selected alongside it without segmenting) and, for the
resource's own fields, whether each is selectable and filterable. Existing entries are kept; new resources are added.
"""
import html, json, os, re, sys, urllib.error, urllib.request

version, resources = sys.argv[1], sys.argv[2:]
path = f"inventory/google-ads-{version}-gaql.json"
data = json.load(open(path)) if os.path.exists(path) else {"version": version, "resources": {}}

def text(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        s = r.read().decode("utf-8", "ignore")
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", s, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", s))
    return [l.strip() for l in t.split("\n") if l.strip()]

for res in resources:
    if res in data["resources"]:
        continue
    try:
        lines = text(f"https://developers.google.com/google-ads/api/fields/{version}/{res}")
    except urllib.error.HTTPError as e:
        print(res, "NOT FOUND", e.code)
        continue
    attributed = []
    if "Attributed resources" in lines:
        i = lines.index("Attributed resources") + 1
        while i < len(lines) and re.fullmatch(r"[a-z_]+", lines[i]):
            attributed.append(lines[i]); i += 1
    fields = {}
    for i, l in enumerate(lines):
        if re.fullmatch(rf"{res}\.[a-z0-9_.]+", l) and i + 1 < len(lines) and lines[i + 1] == "Field description":
            block = lines[i:i + 400]
            def flag(name):
                for j, b in enumerate(block):
                    if b == name and j + 1 < len(block):
                        return block[j + 1] == "True"
                return None
            fields[l] = {"selectable": flag("Selectable"), "filterable": flag("Filterable")}
    data["resources"][res] = {"attributed": attributed, "fields": fields}
    print(res, len(attributed), "attributed,", len(fields), "fields", flush=True)
    json.dump(data, open(path, "w"), indent=0, sort_keys=True)  # saved after each resource
