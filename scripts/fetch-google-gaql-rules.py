"""Records GAQL selection rules from Google's field reference pages into inventory/google-ads-<version>-gaql.json.

Usage: python3 scripts/fetch-google-gaql-rules.py v26 campaign ad_group ...
       python3 scripts/fetch-google-gaql-rules.py v26 --refresh   (refetch every recorded resource)
       python3 scripts/fetch-google-gaql-rules.py v26 --segments  (record which metrics and segments each segment can be selected with)
Source pages: https://developers.google.com/google-ads/api/fields/<version>/<resource>

For each resource: the metrics and segments usable with it in FROM, the attributed resources (whose fields may be selected alongside it without segmenting), the
segmenting resources (whose fields act as segments: selecting them splits rows, and filtering on them requires selecting them) and, for the
resource's own fields, whether each is selectable and filterable. Existing entries are kept; new resources are added.
"""
import html, json, os, re, sys, urllib.error, urllib.request

version, resources = sys.argv[1], sys.argv[2:]
path = f"inventory/google-ads-{version}-gaql.json"
data = json.load(open(path)) if os.path.exists(path) else {"version": version, "resources": {}}
refresh = "--refresh" in resources
segments = "--segments" in resources
resources = [r for r in resources if r not in ("--refresh", "--segments")]
if refresh:
    resources = sorted(set(resources) | set(data["resources"]))

def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read().decode("utf-8", "ignore")

def text(s):
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", s, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", s))
    return [l.strip() for l in t.split("\n") if l.strip()]

for res in resources:
    if res in data["resources"] and not refresh:
        continue
    try:
        raw = fetch(f"https://developers.google.com/google-ads/api/fields/{version}/{res}")
        lines = text(raw)
    except urllib.error.HTTPError as e:
        print(res, "NOT FOUND", e.code)
        continue
    def listed(heading):
        out = []
        if heading in lines:
            i = lines.index(heading) + 1
            while i < len(lines) and re.fullmatch(r"[a-z_]+", lines[i]):
                out.append(lines[i]); i += 1
        return out
    attributed, segmenting = listed("Attributed resources"), listed("Segmenting resources")
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
    # Metrics and segments the page marks as usable when this resource is in the FROM clause ("Yes, it is").
    from_ok = sorted(set(re.findall(r'#((?:metrics|segments)\.[a-z0-9_.]+)">[a-z0-9_.]+<!-- Yes, it is -->', raw)))
    data["resources"][res] = {"attributed": attributed, "segmenting": segmenting, "fields": fields, "from_metrics_segments": from_ok}
    print(res, len(attributed), "attributed,", len(segmenting), "segmenting,", len(fields), "fields", flush=True)
    json.dump(data, open(path, "w"), indent=0, sort_keys=True)  # saved after each resource

if segments:
    # Each segment's "Selectable with" list on the segments reference page: the metrics and segments it can be combined with.
    # (Resources are listed too but not recorded: attributed resources are never listed, so the FROM rules cover those.)
    t = " ".join(text(fetch(f"https://developers.google.com/google-ads/api/fields/{version}/segments")))
    compat = {}
    for m in re.finditer(r"(segments\.[a-z0-9_.]+) Field description (.*?)(?=segments\.[a-z0-9_.]+ Field description|$)", t):
        sel = m.group(2).split("can be selected with this field:", 1)
        if len(sel) == 2:
            compat[m.group(1)] = sorted(set(re.findall(r"(?<![\w.])((?:metrics|segments)\.[a-z0-9_.]+)", sel[1])) - {m.group(1)})
    data["segments_selectable_with"] = compat
    print(len(compat), "segments recorded")
    json.dump(data, open(path, "w"), indent=0, sort_keys=True)
