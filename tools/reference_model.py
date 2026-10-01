"""Independent reference implementation of docs/BLUEPRINT.md §E (Tier A, Tier B, list, rounding).

This is the oracle for the TypeScript domain tests: it reads scenarios.json, computes every
intermediate number from the spec formulas, and writes goldens.json. It shares no code with the
TS implementation. Run:

    python tools/make_scenarios.py && python tools/reference_model.py
"""
import json
import math
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parents[1] / "frontend/src/domain/__tests__"
TZ = ZoneInfo("Asia/Manila")
DAY = 86400.0
MULT = {"payday": 1.3, "fri_sat": 1.15}


# ---------------- calendar ----------------
def parse(ts):
    return datetime.fromisoformat(ts).astimezone(TZ)


def local_date(dt):
    return dt.date()


def last_day(d):
    return ((d.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)).day


def is_payday(d):
    return d.day in (15, 16, 30, 1) or d.day == last_day(d)


def js_weekday(d):  # 0=Sun..6=Sat
    return (d.weekday() + 1) % 7


def mult(d):
    m = 1.0
    if is_payday(d):
        m = max(m, MULT["payday"])
    if js_weekday(d) in (5, 6):
        m = max(m, MULT["fri_sat"])
    return m


def demand(rate, a, b):
    s, d = 0.0, a
    while d < b:
        s += rate * mult(d)
        d += timedelta(days=1)
    return s


def next_trip(today, rd, override):
    if override:
        return date.fromisoformat(override)
    if not rd:
        return today
    for i in range(7):
        d = today + timedelta(days=i)
        if js_weekday(d) in rd:
            return d
    return today


def following(nt, rd):
    if not rd:
        return nt + timedelta(days=7)
    for i in range(1, 8):
        d = nt + timedelta(days=i)
        if js_weekday(d) in rd:
            return d
    return nt + timedelta(days=7)


def noon(d):
    return datetime(d.year, d.month, d.day, 12, tzinfo=TZ)


def packs_for(units, rate, pack, floor):
    return max(floor, math.ceil((units - 0.5 * rate) / pack))


# ---------------- events ----------------
def total_order_key(e):
    return (parse(e["ts"]).timestamp(), 0 if e["type"] == "COUNT" else 1, e["id"])


def active(events):
    seen, voided, out = set(), set(), []
    for e in events:
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        if e["type"] == "VOID":
            voided.add(e["target"])
        else:
            out.append(e)
    return sorted([e for e in out if e["id"] not in voided], key=total_order_key)


# ---------------- Tier B ----------------
def tier_b(events, now):
    anchor, net, sold, inconsistent, raw = None, 0.0, 0.0, False, []
    for e in events:
        if e["type"] == "PURCHASE":
            net += e["qty_units"]
        elif e["type"] == "ADJUST":
            net += e["delta"]
        elif e["type"] == "SALE":  # tally: never part of a sample (the next count reflects it)
            sold += e["qty_units"]
        elif e["type"] == "COUNT":
            t = parse(e["ts"])
            if anchor:
                days = (t - anchor["t"]).total_seconds() / DAY
                if days < 1:
                    pass
                else:
                    used = anchor["qty"] + net - e["qty_on_hand"]
                    if used < 0:
                        inconsistent = True
                    else:
                        inconsistent = False
                        raw.append({"rate": used / days, "days": days, "start": anchor["t"], "end": t})
            anchor = {"t": t, "qty": e["qty_on_hand"]}
            net = 0.0
            sold = 0.0
    kept = [s for s in raw if (now - s["end"]).total_seconds() / DAY <= 90]
    for s in kept:
        s["capped"] = s["rate"]
    if len(kept) >= 3:
        cap = 3 * median([s["rate"] for s in kept])
        for s in kept:
            s["capped"] = min(s["rate"], cap)
    rate = hist = None
    weights = []
    if kept:
        sw = srw = 0.0
        for s in kept:
            age = (now - s["end"]).total_seconds() / DAY
            w = s["days"] * 0.5 ** (age / 14)
            weights.append(w)
            sw += w
            srw += s["capped"] * w
        rate = srw / sw
        hist = (now - min(s["start"] for s in kept)).total_seconds() / DAY
    # confidence
    if not kept:
        conf = "none"
    else:
        if len(kept) < 2 or hist < 14:
            conf = "low"
        elif len(kept) >= 4 and hist >= 28:
            conf = "high"
        else:
            conf = "mid"
        newest_age = (now - max(s["end"] for s in kept)).total_seconds() / DAY
        if inconsistent or newest_age > 28:
            conf = {"high": "mid", "mid": "low", "low": "low"}[conf]
    return dict(anchor=anchor, samples=kept, weights=weights, inconsistent=inconsistent, net=net, sold=sold, rate=rate, conf=conf, hist=hist)


# ---------------- Tier A ----------------
def cadence(purchases, now, today):
    win = [p for p in purchases if (now - parse(p["ts"])).total_seconds() / DAY <= 120]
    win.sort(key=lambda p: parse(p["ts"]))
    merged = []
    for p in win:
        t = parse(p["ts"])
        d = local_date(t)
        if merged and merged[-1]["date"] == d:
            merged[-1]["qty"] += p["qty_units"]
        else:
            merged.append({"t": t, "date": d, "qty": p["qty_units"]})
    n = len(merged)
    if n < 3:
        return "n<3", None
    span = (merged[-1]["t"] - merged[0]["t"]).total_seconds() / DAY
    if span < 7:
        return "span<7", None
    cycles = [merged[i]["qty"] / ((merged[i + 1]["t"] - merged[i]["t"]).total_seconds() / DAY) for i in range(n - 1)][-5:]
    if n == 3 and (min(cycles) <= 0 or max(cycles) / min(cycles) >= 3):
        return "unclear", None
    thr = median(cycles)
    typical = median([m["qty"] for m in merged])
    last = merged[-1]
    f = lambda r: timedelta(days=max(1, last["qty"] / r))
    early, mid, late = last["t"] + f(max(cycles)), last["t"] + f(thr), last["t"] + f(min(cycles))
    dormant = today > local_date(mid) + timedelta(days=14)
    return "ok", dict(throughput=thr, typical=typical, n=n, cycles=cycles, early=local_date(early), mid=local_date(mid), late=local_date(late), mid_dt=mid, dormant=dormant)


# ---------------- derive + list ----------------
def run(sc):
    now = parse(sc["now"])
    today = local_date(now)
    ev = active(sc["events"])
    purchases = [e for e in ev if e["type"] == "PURCHASE"]
    ev = [e for e in ev if e["type"] in ("PURCHASE", "COUNT", "ADJUST", "SALE")]
    b = tier_b(ev, now)
    status, cad = cadence(purchases, now, today)
    thr = cad["throughput"] if cad else None
    pack = sc["product"]["pack_size"]
    sell = sc["product"]["sell_price"]
    cost = None
    for p in reversed(purchases):
        if p["total_cost"] is not None:
            cost = p["total_cost"] / p["qty_units"]
            break
    tubo = None if (sell is None or cost is None) else sell - cost
    flags = set()
    if cost is None:
        flags.add("no_cost")
    if sell is None:
        flags.add("no_price")
    if sell is not None and cost is not None and cost >= sell:
        flags.add("lugi_check")
    if b["inconsistent"]:
        flags.add("inconsistent")
    if status == "unclear":
        flags.add("unclear")

    ns = len(b["samples"])
    if ns >= 2:
        tier, rate, conf = "counts", b["rate"], b["conf"]
    elif ns == 1:
        tier = "counts"
        sr = b["rate"]
        if thr and (sr == 0 or sr / thr > 3 or thr / sr > 3):
            rate, conf = thr, "low"
            flags.add("count_mismatch")
        else:
            rate, conf = sr, b["conf"]
    elif b["anchor"]:
        tier = "counts"
        rate, conf = (thr, "low") if thr else (None, "none")
    elif cad:
        tier, rate, conf = "cadence", None, "low"
        if cad["dormant"]:
            flags.add("dormant")
    else:
        tier, rate, conf = "none", None, "none"

    on_hand = days_since = days_left = None
    if b["anchor"]:
        days_since = (now - b["anchor"]["t"]).total_seconds() / DAY
        # tally: the larger of tallied sales and estimated use since the count
        on_hand = max(0.0, b["anchor"]["qty"] + b["net"] - max(b["sold"], (rate or 0) * days_since))
        if rate:
            days_left = on_hand / rate
        if days_since > 14:
            flags.add("needs_count")
        if rate is not None and rate < 0.25 and days_left is not None and days_left > 30:
            flags.add("slow")

    rd = sc["store"]["restock_days"]
    ov = sc["store"]["next_trip_override"]
    nt = next_trip(today, rd, ov)
    fo = following(nt, rd)
    has_sched = bool(rd) or ov is not None

    g = dict(tier=tier, confidence=conf, rate=rate, on_hand=on_hand, days_since_count=days_since, days_left=days_left,
             unit_cost=cost, tubo=tubo, flags=sorted(flags), cadence_status=status,
             samples=[{"rate": s["rate"], "days": s["days"], "capped": s["capped"]} for s in b["samples"]], weights=b["weights"],
             next_trip=nt.isoformat(), following=fo.isoformat(), listed=False)
    if cad:
        g["cadence"] = dict(throughput=thr, typical=cad["typical"], n=cad["n"], cycles=cad["cycles"],
                            rebuy=[cad["early"].isoformat(), cad["mid"].isoformat(), cad["late"].isoformat()], dormant=cad["dormant"])

    def tb(r):
        oh = max(0.0, b["anchor"]["qty"] + b["net"] - max(b["sold"], r * days_since))
        dl = oh / r
        need = demand(r, nt, fo)
        buf = max(r, 0.2 * need)
        at = oh - demand(r, today, nt)
        if at < 0 or (dl <= 1 and r >= 0.5):
            u = "red"
        elif at < need:
            u = "orange"
        elif at < need + buf:
            u = "yellow"
        else:
            u = "green"
        if r < 0.5 and u == "red":
            u = "orange"
        units = max(0.0, need + buf - max(0.0, at))
        return dict(need=need, buffer=buf, at_trip=at, urgency=u, units=units)

    def tb_packs(x, r):
        if x["urgency"] in ("red", "orange"):
            return packs_for(x["units"], r, pack, 1), False
        if x["urgency"] == "yellow":
            if x["units"] < 0.25 * pack:
                return 0, True
            return max(1, packs_for(x["units"], r, pack, 0)), False
        return 0, False

    if tier == "counts" and rate:
        x = tb(rate)
        g.update(x)
        if x["urgency"] != "green":
            packs, deferred = tb_packs(x, rate)
            needs_count = ("needs_count" in flags) or (x["urgency"] in ("red", "orange") and days_since > 7)
            rng = None
            if (conf == "low" or needs_count) and not deferred:
                lo, hi = tb(rate * 0.7), tb(rate * 1.3)
                pl = tb_packs({**lo, "urgency": "yellow" if lo["urgency"] == "green" else lo["urgency"]}, rate * 0.7)[0]
                ph = tb_packs({**hi, "urgency": "yellow" if hi["urgency"] == "green" else hi["urgency"]}, rate * 1.3)[0]
                a, c = min(pl, ph, packs), max(pl, ph, packs)
                rng = None if a == c else [a, c]
            value = tubo if tubo is not None else (sell if sell is not None else 1)
            g.update(listed=True, packs=packs, deferred=deferred, needs_count=needs_count, range=rng,
                     section=("wag_muna" if deferred else "bilhin_na" if x["urgency"] == "red" else "bilhin"),
                     priority=max(0.0, x["need"] - x["at_trip"]) * value, before_trip=x["at_trip"] < 0,
                     cost=None if (cost is None or packs == 0) else packs * pack * cost)
    elif tier == "cadence" and cad and not cad["dormant"]:
        listed = cad["mid"] < fo
        g["listed"] = listed
        if listed:
            if has_sched:
                carry = thr * max(0.0, (cad["mid_dt"] - noon(nt)).total_seconds() / DAY)
                units = max(0.0, demand(thr, nt, fo) - carry)
                cap_units = cad["typical"] * (2 if cad["n"] >= 6 else 1)
                cap_packs = math.ceil(cap_units / pack)
                packs = min(max(1, packs_for(units, thr, pack, 1)), cap_packs)
                g.update(carry=carry, units=units, cap_packs=cap_packs, packs=packs, weekly_hint=None)
            else:
                packs = math.ceil(cad["typical"] / pack)
                g.update(carry=0.0, units=cad["typical"], cap_packs=packs, packs=packs, weekly_hint=math.ceil(thr * 7 / pack))
            g.update(section="bilhin", urgency="orange", cost=None if cost is None else g["packs"] * pack * cost)
    return g


def main():
    src = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
    out = {s["id"]: run(s) for s in src["scenarios"]}
    (HERE / "goldens.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")
    for k, v in out.items():
        brief = {x: v.get(x) for x in ("tier", "rate", "listed", "packs", "urgency", "section", "range", "flags")}
        if "cadence" in v:
            brief["thr"] = round(v["cadence"]["throughput"], 3)
            brief["rebuy"] = v["cadence"]["rebuy"]
        print(k, brief)


if __name__ == "__main__":
    main()
