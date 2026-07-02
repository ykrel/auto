#!/usr/bin/env python3
"""Job self-check. Run from the job root: python3 validate.py
Passes only when every batch item has a complete 5-language entry in output/."""
import json
import glob
import sys

need = {}
for bf in sorted(glob.glob("batches/job-*.json")):
    for row in json.load(open(bf)):
        need[row["itemCode"]] = bf

done = {}
problems = []
for of in sorted(glob.glob("output/*.json")):
    try:
        d = json.load(open(of))
    except Exception as e:
        problems.append(f"{of}: JSON PARSE FAIL — {e}")
        continue
    for k, v in d.items():
        if not isinstance(v, dict):
            problems.append(f"{of}:{k}: entry is not an object")
            continue
        if "tr" not in v or not isinstance(v["tr"], str) or len(v["tr"]) < 40:
            problems.append(f"{of}:{k}: 'tr' missing/too short")
            continue
        bad = False
        for lang in ["en", "de", "fr", "es"]:
            loc = v.get(lang)
            if not isinstance(loc, dict) or not loc.get("name") or not loc.get("desc") or len(loc["desc"]) < 40:
                problems.append(f"{of}:{k}: '{lang}' missing name/desc")
                bad = True
        if not bad:
            done[k] = of

missing = sorted(set(need) - set(done))
extra = sorted(set(done) - set(need))

print(f"needed: {len(need)}  complete: {len(done)}  missing: {len(missing)}  extra: {len(extra)}")
if problems:
    print("\nPROBLEMS (first 20):")
    for p in problems[:20]:
        print(" -", p)
if missing:
    print("\nMISSING itemCodes (first 30):", ", ".join(missing[:30]))

sys.exit(0 if (not missing and not problems) else 1)
