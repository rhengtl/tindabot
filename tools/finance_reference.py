"""Independent reference implementation of BLUEPRINT §E6 (P2 finance rules).

Writes frontend/src/domain/__tests__/finance_scenarios.json = { scenarios: [{id, note, now,
events, customers?, budget?, lines?, expect}] }. Kept deliberately separate from the TypeScript
domain code: same inputs, independently written arithmetic.

Run: python tools/finance_reference.py
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Manila")
OUT = Path(__file__).resolve().parent.parent / "frontend/src/domain/__tests__/finance_scenarios.json"


def d2(x) -> float:
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def ts(day: str, hh: int = 12, mm: int = 0) -> str:
    return datetime.fromisoformat(f"{day}T{hh:02d}:{mm:02d}:00").replace(tzinfo=TZ).isoformat()


def parse(t: str) -> datetime:
    return datetime.fromisoformat(t)


# ---- event construction -------------------------------------------------------------------
_n = 0


def ev(typ: str, when: str, **fields):
    global _n
    _n += 1
    return {"id": fields.pop("id", f"E{_n:04d}"), "type": typ, "ts": when, **fields}


# ---- total order / active set (independent) ---------------------------------------------------
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
    out = [e for e in out if e["id"] not in voided]
    out.sort(key=lambda e: (parse(e["ts"]).timestamp(), 0 if e["type"] == "COUNT" else 1, e["id"]))
    return out


# ---- customer -------------------------------------------------------------------------------
def customer(cid, act):
    utang = [e for e in act if e["type"] == "UTANG" and e["customer_id"] == cid]
    bayad = [e for e in act if e["type"] == "BAYAD" and e["customer_id"] == cid]
    tu = d2(sum(Decimal(str(e["amount"])) for e in utang))
    tb = d2(sum(Decimal(str(e["amount"])) for e in bayad))
    bal = d2(Decimal(str(tu)) - Decimal(str(tb)))
    oldest = None
    if bal > 0:
        cum = Decimal("0")
        for e in utang:  # already in total order
            cum += Decimal(str(e["amount"]))
            if cum > Decimal(str(tb)):
                oldest = e["ts"]
                break
    return {
        "customer_id": cid,
        "balance": bal,
        "total_utang": tu,
        "total_bayad": tb,
        "last_utang_ts": utang[-1]["ts"] if utang else None,
        "last_bayad_ts": bayad[-1]["ts"] if bayad else None,
        "oldest_unpaid_ts": oldest,
    }


def outstanding(act):
    ids = []
    for e in act:
        if e["type"] in ("UTANG", "BAYAD") and e["customer_id"] not in ids:
            ids.append(e["customer_id"])
    return d2(sum(max(0, customer(c, act)["balance"]) for c in ids))


# ---- weeks ----------------------------------------------------------------------------------
def week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())  # Monday


def week(start: date, act):
    end = start + timedelta(days=6)
    s = datetime.combine(start, datetime.min.time()).replace(tzinfo=TZ)
    e_ = datetime.combine(end + timedelta(days=1), datetime.min.time()).replace(tzinfo=TZ)
    gastos = nabili = given = received = Decimal("0")
    cash = None
    for e in act:
        t = parse(e["ts"])
        if not (s <= t < e_):
            continue
        if e["type"] == "EXPENSE":
            gastos += Decimal(str(e["amount"]))
        elif e["type"] == "PURCHASE" and e.get("total_cost") is not None:
            nabili += Decimal(str(e["total_cost"]))
        elif e["type"] == "UTANG":
            given += Decimal(str(e["amount"]))
        elif e["type"] == "BAYAD":
            received += Decimal(str(e["amount"]))
        elif e["type"] == "CASH_COUNT":
            cash = e["amount"]
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "gastos": d2(gastos),
        "nabili": d2(nabili),
        "utang_given": d2(given),
        "utang_received": d2(received),
        "cash_count": cash,
        "outstanding_end": outstanding([x for x in act if parse(x["ts"]) < e_]),
    }


def store_state(now: str, act, rates):
    n = parse(now)
    monday = week_start(n.date())
    weeks = [week(monday - timedelta(days=7 * i), act) for i in range(4)]
    cash = [e for e in act if e["type"] == "CASH_COUNT"]
    cash_last = {"ts": cash[-1]["ts"], "amount": cash[-1]["amount"]} if cash else None
    benta = tubo = 0.0
    inc = skip = 0
    for r in rates:  # {tier, rate, sell_price, tubo}
        if r["tier"] != "counts" or r["rate"] is None or r["rate"] <= 0:
            continue
        if r["sell_price"] is None or r["tubo"] is None:
            skip += 1
            continue
        inc += 1
        benta += r["rate"] * 7 * r["sell_price"]
        tubo += r["rate"] * 7 * r["tubo"]
    prefill = None
    if cash_last and (n - parse(cash_last["ts"])).total_seconds() / 86400 <= 2:
        prefill = cash_last["amount"]
    return {
        "cash_last": cash_last,
        "utang_outstanding": outstanding(act),
        "weeks": weeks,
        "tantiya": {"benta": benta, "tubo": tubo, "products": inc, "skipped": skip},
        "budget_prefill": prefill,
    }


# ---- budget ---------------------------------------------------------------------------------
def budget(lines, total_known_cost, amount):
    order = {"bilhin_na": 0, "bilhin": 1, "wag_muna": 2}
    ls = [l for l in lines if l["section"] != "wag_muna" and l["cost"] is not None and l["buy_packs"] > 0]
    ls.sort(key=lambda l: (order[l["section"]], -l["priority"], l["product_id"]))
    remaining = Decimal(str(amount))
    spent = Decimal("0")
    out = []
    for l in ls:
        per = Decimal(str(l["cost"])) / l["buy_packs"]
        afford = int(remaining / per) if remaining > 0 else 0
        packs = max(1, min(l["buy_packs"], afford))
        spend = per * packs
        remaining -= spend
        spent += spend
        out.append({"product_id": l["product_id"], "packs": packs, "reduced": packs < l["buy_packs"], "spend": d2(spend)})
    return {"budget": amount, "lines": out, "kulang": max(0.0, d2(Decimal(str(total_known_cost)) - Decimal(str(amount)))), "spent": d2(spent)}


# ---- scenarios ------------------------------------------------------------------------------
NOW = ts("2026-09-14", 15)  # Monday
C1, C2, C3 = "CUST0000000000000000000001", "CUST0000000000000000000002", "CUST0000000000000000000003"
scenarios = []


def add(sid, note, events, rates=(), budget_in=None, lines=None, total_known_cost=None, now=NOW):
    act = active(events)
    ids = []
    for e in act:
        if e["type"] in ("UTANG", "BAYAD") and e["customer_id"] not in ids:
            ids.append(e["customer_id"])
    exp = {"customers": {c: customer(c, act) for c in ids}, "store": store_state(now, act, list(rates))}
    sc = {"id": sid, "note": note, "now": now, "events": events, "rates": list(rates), "expect": exp}
    if budget_in is not None:
        sc["budget"] = budget_in
        sc["lines"] = lines
        sc["total_known_cost"] = total_known_cost
        sc["expect"]["budget"] = budget(lines, total_known_cost, budget_in)
    scenarios.append(sc)


add("F1_fifo", "two utang, one partial payment → oldest unpaid is the second utang", [
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=100),
    ev("UTANG", ts("2026-09-05"), customer_id=C1, amount=50, note="gatas"),
    ev("BAYAD", ts("2026-09-10"), customer_id=C1, amount=120),
])
add("F2_overpay", "payment exceeds utang → negative balance (sobra), no oldest unpaid", [
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=100),
    ev("BAYAD", ts("2026-09-02"), customer_id=C1, amount=150),
])
add("F3_prepay", "payment before any utang counts as credit (FIFO over all payments)", [
    ev("BAYAD", ts("2026-09-01"), customer_id=C1, amount=100),
    ev("UTANG", ts("2026-09-03"), customer_id=C1, amount=60),
    ev("UTANG", ts("2026-09-08"), customer_id=C1, amount=70),
])
u200 = ev("UTANG", ts("2026-09-04"), customer_id=C1, amount=200)
add("F4_void", "VOID removes an utang; VOID listed before its target", [
    ev("VOID", ts("2026-09-12"), target=u200["id"]),
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=100),
    u200,
    ev("BAYAD", ts("2026-09-10"), customer_id=C1, amount=100),
])
add("F5_same_ts", "utang and bayad at the same ts → id order; balance unaffected", [
    ev("BAYAD", ts("2026-09-05"), customer_id=C1, amount=100, id="ZZ01"),
    ev("UTANG", ts("2026-09-05"), customer_id=C1, amount=100, id="AA01"),
    ev("UTANG", ts("2026-09-05"), customer_id=C1, amount=40, id="AA02"),
])
add("F6_outstanding", "three customers: 30 + (−50 → 0) + 200 = 230", [
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=100),
    ev("UTANG", ts("2026-09-05"), customer_id=C1, amount=50),
    ev("BAYAD", ts("2026-09-10"), customer_id=C1, amount=120),
    ev("UTANG", ts("2026-09-02"), customer_id=C2, amount=100),
    ev("BAYAD", ts("2026-09-03"), customer_id=C2, amount=150),
    ev("UTANG", ts("2026-08-20"), customer_id=C3, amount=200),
])
add("F7_weeks", "four Mon–Sun weeks, cash count last-wins within a week, outstanding as of week end", [
    ev("EXPENSE", ts("2026-09-14", 9), amount=45.5, category="kuryente"),
    ev("EXPENSE", ts("2026-09-08"), amount=100, category="pamasahe"),
    ev("PURCHASE", ts("2026-09-09"), product_id="PROD00000000000000000000001", qty_units=12, total_cost=780),
    ev("PURCHASE", ts("2026-09-09", 13), product_id="PROD00000000000000000000001", qty_units=12, total_cost=None),
    ev("UTANG", ts("2026-09-02"), customer_id=C1, amount=100),
    ev("BAYAD", ts("2026-09-16"), customer_id=C1, amount=40),
    ev("CASH_COUNT", ts("2026-09-08", 9), amount=1500),
    ev("CASH_COUNT", ts("2026-09-13", 20), amount=1200),
    ev("CASH_COUNT", ts("2026-09-14", 8), amount=900),
], rates=[
    {"tier": "counts", "rate": 3.0, "sell_price": 75, "tubo": 10},
    {"tier": "counts", "rate": 1.5, "sell_price": None, "tubo": None},
    {"tier": "cadence", "rate": None, "sell_price": 20, "tubo": 5},
    {"tier": "counts", "rate": 0.5, "sell_price": 16, "tubo": 3.5},
])
add("F8_stale_cash", "last cash count 3 days old → no budget prefill", [
    ev("CASH_COUNT", ts("2026-09-11", 9), amount=2000),
])
add("F9_decimals", "two-decimal amounts sum exactly", [
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=10.10),
    ev("UTANG", ts("2026-09-02"), customer_id=C1, amount=20.20),
    ev("BAYAD", ts("2026-09-03"), customer_id=C1, amount=30.30),
])
add("F10_budget", "greedy by section then priority; ≥ 1 pack each; kulang = total − budget", [],
    budget_in=1100, total_known_cost=1500, lines=[
        {"product_id": "P_A", "section": "bilhin_na", "priority": 5, "buy_packs": 3, "cost": 300},
        {"product_id": "P_B", "section": "bilhin_na", "priority": 9, "buy_packs": 2, "cost": 1000},
        {"product_id": "P_C", "section": "bilhin", "priority": 7, "buy_packs": 4, "cost": 200},
        {"product_id": "P_D", "section": "bilhin", "priority": 1, "buy_packs": 2, "cost": None},
        {"product_id": "P_E", "section": "wag_muna", "priority": 8, "buy_packs": 1, "cost": 50},
    ])
add("F11_budget_enough", "budget covers everything → nothing reduced, kulang 0", [],
    budget_in=5000, total_known_cost=1500, lines=[
        {"product_id": "P_A", "section": "bilhin_na", "priority": 5, "buy_packs": 3, "cost": 300},
        {"product_id": "P_B", "section": "bilhin", "priority": 9, "buy_packs": 2, "cost": 1000},
    ])
add("F12_duplicate_ids", "duplicate event ids are ignored (write-once)", [
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=100, id="DUP1"),
    ev("UTANG", ts("2026-09-01"), customer_id=C1, amount=100, id="DUP1"),  # identical re-submit
    ev("BAYAD", ts("2026-09-02"), customer_id=C1, amount=30, id="DUP2"),
    ev("BAYAD", ts("2026-09-02"), customer_id=C1, amount=30, id="DUP2"),
])

OUT.write_text(json.dumps({"scenarios": scenarios}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {len(scenarios)} scenarios -> {OUT}")
for s in scenarios:
    c = s["expect"]["customers"]
    print(s["id"], {k: (v["balance"], v["oldest_unpaid_ts"] and v["oldest_unpaid_ts"][:10]) for k, v in c.items()}, "outstanding", s["expect"]["store"]["utang_outstanding"])
