"""Generate the shared scenario file used by both the Python reference oracle and the TS tests.

Scenarios are the validated cases from docs/BLUEPRINT.md §I. Events are written as the app
would store them (selling units, ISO timestamps with +08:00 offset). Run:

    python tools/make_scenarios.py
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "frontend/src/domain/__tests__/scenarios.json"
NOW = "2026-05-29T10:00:00+08:00"
WS = [3, 6]  # Wed, Sat (JS weekday: 0=Sun)

COKE = {"pack_size": 12, "sell_price": 75, "unit_label": "bote", "pack_label": "case"}
LUCKY = {"pack_size": 24, "sell_price": 16, "unit_label": "pack", "pack_label": "box"}
EDEN = {"pack_size": 12, "sell_price": 97, "unit_label": "piraso", "pack_label": "box"}


def ts(m, d, h=12, y=2026):
    return f"{y}-{m:02d}-{d:02d}T{h:02d}:00:00+08:00"


def purchases(days, qty=12, cost=None, hour=12, per_unit=None):
    ev = []
    for (m, d) in days:
        q = qty(m, d) if callable(qty) else qty
        c = cost if cost is not None else (None if per_unit is None else round(per_unit * q, 2))
        ev.append({"type": "PURCHASE", "ts": ts(m, d, hour), "qty_units": q, "total_cost": c})
    return ev


def count(m, d, q, h=21):
    return {"type": "COUNT", "ts": ts(m, d, h), "qty_on_hand": q}


def linked(m, d, natira, qty, cost, h=10):
    """count-at-restock: COUNT and PURCHASE share the same ts; COUNT sorts first by type rank."""
    return [
        {"type": "COUNT", "ts": ts(m, d, h), "qty_on_hand": natira},
        {"type": "PURCHASE", "ts": ts(m, d, h), "qty_units": qty, "total_cost": cost},
    ]


S = []


def add(id_, kind, product, events, restock_days=WS, override=None, now=NOW, note=""):
    S.append({
        "id": id_, "kind": kind, "note": note, "now": now,
        "store": {"restock_days": restock_days, "next_trip_override": override},
        "product": product, "events": events,
    })


# ---------------- Tier A (Coke, case 12 @ 780) ----------------
c780 = dict(cost=780)
add("A1", "tierA", COKE, purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22), (5, 26)], **c780), note="regular n=6")
add("A1_n5", "tierA", COKE, purchases([(5, 10), (5, 14), (5, 18), (5, 22), (5, 26)], **c780), note="regular n=5 → cap 1x")
add("A2", "tierA", COKE, purchases([(5, 1), (5, 5), (5, 17), (5, 21), (5, 25)], qty=lambda m, d: {5: 36, 21: 24}.get(d, 12), per_unit=65), note="promo irregular quantities (cycles 3,3,3,6 → median 3)")
add("A3", "tierA", COKE, purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22)], qty=lambda m, d: 60 if d == 22 else 12, per_unit=65), note="one huge last buy")
add("A4", "tierA", COKE, purchases([(5, 2), (5, 6), (5, 14), (5, 18), (5, 22), (5, 26)], **c780), note="skipped purchase")
add("A5", "tierA", COKE, purchases([(5, 1), (5, 5), (5, 9), (5, 13)], **c780), note="long silence, not yet dormant")
add("A5_dormant", "tierA", COKE, purchases([(5, 1), (5, 5), (5, 9), (5, 13)], **c780), now="2026-06-01T10:00:00+08:00", note="long silence → dormant")
add("A7", "tierA", COKE, purchases([(3, 1), (3, 20), (4, 10)], **c780), note="probably dead → dormant")
add("A8", "tierA", COKE, purchases([(5, 17), (5, 21), (5, 25)], **c780), note="minimum 3, clear")
add("A8b", "tierA", COKE, purchases([(5, 17), (5, 18), (5, 25)], **c780), note="minimum 3, unclear ratio 7")
add("A9", "tierA", COKE, purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22), (5, 26)], **c780), restock_days=[], note="no schedule")
add("A10", "tierA", COKE, purchases([(5, 4), (5, 9), (5, 14), (5, 19), (5, 24)], **c780), note="gap 5, rebuy today")
add("A10b", "tierA", COKE, purchases([(5, 6), (5, 11), (5, 16), (5, 21), (5, 26)], **c780), note="gap 5, rebuy after trip")
# adversarial a–l
add("adv_a", "tierA", COKE, purchases([(5, 2), (5, 10), (5, 18), (5, 26)], qty=24, cost=1560), note="2 cases, 1 case always left")
add("adv_b", "tierA", COKE, purchases([(5, 2), (5, 6), (5, 14), (5, 18), (5, 22), (5, 26)], **c780), note="other supplier one cycle")
add("adv_c", "tierA", COKE, purchases([(5, 2), (5, 6), (5, 10), (5, 20), (5, 24), (5, 28)], **c780), note="closed 6 days")
add("adv_d", "tierA", COKE, purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22), (5, 24), (5, 26), (5, 28)], **c780), note="demand doubles, 2 new cycles")
add("adv_d2", "tierA", COKE, purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 20), (5, 22), (5, 24), (5, 26), (5, 28)], **c780), note="demand doubles, 3 new cycles")
add("adv_e", "tierA", COKE, purchases([(5, 1), (5, 5), (5, 9), (5, 13), (5, 21), (5, 29)], **c780), note="demand halves, 2 new cycles")
add("adv_f", "tierA", {"pack_size": 24, "sell_price": 20, "unit_label": "pack", "pack_label": "box"},
    purchases([(3, 15), (4, 4), (5, 9), (5, 29)], qty=24, cost=400), note="slow irregular")
add("adv_g", "tierA", COKE, purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22)], qty=lambda m, d: 36 if d == 22 else 12, per_unit=65), note="promo 3 cases last")
add("adv_h", "tierA", {"pack_size": 30, "sell_price": 16, "unit_label": "pack", "pack_label": "box"},
    purchases([(5, 2), (5, 10), (5, 18), (5, 28)], qty=lambda m, d: 30 if d >= 18 else 24, per_unit=13.75), note="pack change 24→30")
add("adv_i", "tierA", COKE, purchases([(5, 2), (5, 6), (5, 10), (5, 14)], **c780) + purchases([(5, 29), (5, 29), (5, 29)], **c780), note="3 late entries dated today (merged)")
add("adv_j", "tierA", COKE, purchases([(5, 22), (5, 25), (5, 29)], **c780), note="n=3 spanning exactly 7 d")
add("adv_k", "tierA", COKE, purchases([(5, 17), (5, 21), (5, 25)], qty=lambda m, d: 36 if d == 21 else 12, per_unit=65), note="n=3 cycle exactly 3×")
add("adv_l", "tierA", COKE, purchases([(5, 17), (5, 21), (5, 25)], qty=lambda m, d: 37 if d == 21 else 12, per_unit=65), note="n=3 cycle 3.08×")
# trip spacing
reg6 = purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22), (5, 26)], **c780)
add("trip_1d", "tierA", COKE, reg6, restock_days=[0, 1, 2, 3, 4, 5, 6], note="trips daily → not listed today")
add("trip_2d", "tierA", COKE, reg6, restock_days=[0, 2, 4, 6], note="trips every 2 d")
add("trip_7d", "tierA", COKE, reg6, restock_days=[6], note="trips every 7 d")
add("trip_override", "tierA", COKE, reg6, restock_days=[], override="2026-06-12", note="one-off trip Jun 12")
add("payday_after", "tierA", COKE, purchases([(5, 15), (5, 19), (5, 23), (5, 27), (5, 31), (6, 4)], **c780), now="2026-06-08T10:00:00+08:00", note="payday after trip (Jun 10 trip)")
# units guard: 1,1,1,5,1 boxes of 24, gaps 4,4,4,20
add("units_guard", "tierA", {"pack_size": 24, "sell_price": 16, "unit_label": "pack", "pack_label": "box"},
    purchases([(4, 20), (4, 24), (4, 28), (5, 2), (5, 22)], qty=lambda m, d: 120 if (m, d) == (5, 2) else 24, per_unit=13.75), note="1,1,1,5,1 boxes → throughput 6.0 units/day")

# ---------------- Tier B ----------------
s1 = []
for (d, natira) in [(13, 10), (16, 22), (20, 19), (23, 30), (27, 15)]:
    s1 += linked(5, d, natira, 48, 660)
add("S1", "tierB", LUCKY, s1, note="Lucky Me count-at-restock, payday weekend")

s3_before = [count(5, 16, 22), count(5, 20, 40)]
add("S3_before", "tierB", LUCKY, s3_before, note="forgot purchase → inconsistent")
add("S3_after", "tierB", LUCKY, s3_before + [{"type": "PURCHASE", "ts": ts(5, 17, 12), "qty_units": 48, "total_cost": 660}], note="backdated fix → 7.5/day")

sprite = [count(4, 20, 44), count(4, 26, 26), {"type": "PURCHASE", "ts": ts(4, 28), "qty_units": 36, "total_cost": 2340},
          count(5, 10, 20), {"type": "PURCHASE", "ts": ts(5, 13), "qty_units": 12, "total_cost": 780}]
add("S4_stale", "tierB", COKE, sprite, note="rate 3.0 mid; stale anchor; projected 0")
add("S4_after_count", "tierB", COKE, sprite + [count(5, 29, 9, h=9)], note="count 9 this morning (new sample enters)")

eden_p = [{"type": "PURCHASE", "ts": ts(4, 1), "qty_units": 12, "total_cost": 1020}]
add("S6_slow", "tierB", EDEN, eden_p + [count(4, 29, 46), count(5, 29, 40, h=9)], note="rate 0.2, on-hand 40 → green/slow")
add("S6_zero", "tierB", EDEN, eden_p + [count(4, 29, 6), count(5, 29, 0, h=9)], note="rate 0.2, on-hand 0 → capped orange, 1 box")

# ---------------- Tier A → Tier B transition ----------------
a1 = purchases([(5, 6), (5, 10), (5, 14), (5, 18), (5, 22), (5, 26)], **c780)
t1 = a1 + linked(5, 30, 4, 12, 780)
add("T1_hybrid", "tierB", COKE, t1, now="2026-06-01T10:00:00+08:00", note="first count → hybrid (anchor + throughput)")
t2 = t1 + linked(6, 3, 2, 12, 780)
add("T2_one_sample", "tierB", COKE, t2, now="2026-06-03T11:00:00+08:00", note="second count → single sample 3.5")
t3 = a1 + linked(5, 30, 4, 12, 780) + linked(6, 3, 16, 12, 780)
add("T3_mismatch", "tierB", COKE, t3, now="2026-06-03T11:00:00+08:00", note="Jun 3 count included the new case → sample 0/day → >3x off throughput → count_mismatch, keep throughput")

# assign ids & fill common fields
for s in S:
    for i, e in enumerate(s["events"]):
        e.setdefault("id", f"{s['id']}-{i:03d}")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"tz": "Asia/Manila", "scenarios": S}, indent=1), encoding="utf-8")
print(f"wrote {OUT} ({len(S)} scenarios)")
