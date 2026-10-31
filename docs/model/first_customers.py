"""ForgeX stress-tested model: the path to the first paying customers and an 18-month view.

Replaces the optimistic year-one assumptions in financial_model.py (kept for history) with:
- subscription-first offers priced against what contractors already pay for software,
- owner-delivered work until owner hours run out, then contractors,
- acquisition from explicit funnel rates instead of an assumed client count.

Every input is an ASSUMPTION unless marked VERIFIED. Run: python docs/model/first_customers.py
"""
import json

# --- Offers (prices are hypotheses to test in the first conversations) ------------------
CHECK_PRICE = 500            # Revenue Leak Check, credited to a setup within 30 days
CHECK_HOURS = 5
OFFERS = {
    # setup $, monthly $, setup hours (first build, once templated), monthly cash cost, monthly support hours
    "pipeline": dict(setup=1800, monthly=149, hours_first=16, hours_templated=8, setup_cost=70, monthly_cost=25, support_hours=0.75),
    "numbers":  dict(setup=1200, monthly=99,  hours_first=12, hours_templated=6, setup_cost=0,  monthly_cost=10, support_hours=0.5),
}
MIX = {"pipeline": 0.6, "numbers": 0.4}
# VERIFIED inputs: A2P 10DLC brand $46 + campaign vetting $15 (Twilio help center) are inside pipeline setup_cost.

# --- Acquisition funnels -----------------------------------------------------------------
FUNNELS = {
    # per contact: probability of a booked call, then of a paid Revenue Leak Check
    "warm_intro": dict(to_call=0.60, call_to_check=0.30),
    # cold reply ~5% for small targeted lists (Woodpecker via Lemlist, vendor data), ~40% of replies positive,
    # ~70% of positive replies book a call
    "targeted_cold": dict(to_call=0.05 * 0.40 * 0.70, call_to_check=0.25),
}
CHECK_TO_SETUP = 0.40
MINUTES_PER_CONTACT = {"warm_intro": 15, "targeted_cold": 3}   # asking for an intro vs. a researched, personal cold note
HOURS_PER_CALL = 1.0                                             # prep and the call itself

# --- Operating assumptions -------------------------------------------------------------------
FOUNDER_CAPACITY_HOURS = 140     # per month for selling + delivery
OUTREACH_HOURS_BASE = 30         # per month, ongoing selling
CONTRACTOR_RATE = 75             # $/h when owner hours run out
FIXED_MONTHLY = 150              # tools, accounting software, domain/email (insurance excluded)
INSURANCE_MONTHLY = 100          # tech E&O + general liability, once selling (estimate; get quotes)
CARD_SHARE, CARD_FEE, ACH_FEE_CAP = 0.5, 0.029, 5.0   # VERIFIED Stripe list prices: 2.9% + 30c, ACH 0.8% capped $5
FOUNDER_DRAW = 6000
MONTHS = 18

CASES = {
    # new setups per month after a two-month ramp, monthly churn of subscriptions
    "low": dict(setups_per_month=0.5, churn=0.06),
    "mid": dict(setups_per_month=1.5, churn=0.05),
    "high": dict(setups_per_month=3.0, churn=0.04),
}


def fees(amount):
    return CARD_SHARE * (amount * CARD_FEE + 0.30) + (1 - CARD_SHARE) * min(amount * 0.008, ACH_FEE_CAP)


def first_three():
    out = {}
    for name, f in FUNNELS.items():
        per_contact = f["to_call"] * f["call_to_check"]
        contacts = 3 / per_contact
        calls = contacts * f["to_call"]
        out[name] = dict(contacts_for_3_paid_checks=round(contacts), calls=round(calls, 1),
                         outreach_hours=round(contacts * MINUTES_PER_CONTACT[name] / 60 + calls * HOURS_PER_CALL))
    return out


def unit_economics():
    out = {}
    for name, o in OFFERS.items():
        lifetime_months = 1 / 0.05
        sub_gp = (o["monthly"] - o["monthly_cost"]) * lifetime_months
        out[name] = dict(
            setup_cash_margin=o["setup"] - o["setup_cost"],
            founder_rate_first_build=round((o["setup"] - o["setup_cost"]) / o["hours_first"]),
            founder_rate_templated=round((o["setup"] - o["setup_cost"]) / o["hours_templated"]),
            contractor_setup_margin_pct=round((o["setup"] - o["setup_cost"] - CONTRACTOR_RATE * o["hours_templated"]) / o["setup"] * 100),
            lifetime_months_at_5pct_churn=round(lifetime_months),
            lifetime_gross_profit=round(o["setup"] - o["setup_cost"] + sub_gp),
        )
    out["check"] = dict(price=CHECK_PRICE, founder_rate=round(CHECK_PRICE / CHECK_HOURS))
    return out


def project(case, setups_override=None, price_mult=1.0, monthly_mult=1.0, churn_override=None, hours_mult=1.0):
    c = CASES[case]
    rate = setups_override if setups_override is not None else c["setups_per_month"]
    churn = churn_override if churn_override is not None else c["churn"]
    subs = {k: 0.0 for k in OFFERS}
    built = 0.0
    months, cum = [], 0.0
    draw_month = None
    for m in range(1, MONTHS + 1):
        setups = rate * (0.5 if m <= 2 else 1.0)
        checks = setups / CHECK_TO_SETUP
        revenue = checks * CHECK_PRICE   # converted checks are credited against the setup below
        cash_cost = FIXED_MONTHLY + INSURANCE_MONTHLY
        hours = OUTREACH_HOURS_BASE + checks * CHECK_HOURS
        build_hours = 0.0
        for k, o in OFFERS.items():
            n = setups * MIX[k]
            first = max(0.0, min(n, 3 - built)) if built < 3 else 0.0   # first three builds take longer
            build_hours += (first * o["hours_first"] + (n - first) * o["hours_templated"]) * hours_mult
            revenue += n * (o["setup"] * price_mult - CHECK_PRICE)
            cash_cost += n * o["setup_cost"]
            subs[k] = subs[k] * (1 - churn) + n
            revenue += subs[k] * o["monthly"] * monthly_mult
            cash_cost += subs[k] * o["monthly_cost"]
            hours += subs[k] * o["support_hours"]
            built += n
        founder_build = max(0.0, min(build_hours, FOUNDER_CAPACITY_HOURS - hours))
        contractor_hours = build_hours - founder_build
        cash_cost += contractor_hours * CONTRACTOR_RATE + fees(revenue)
        operating = revenue - cash_cost
        cum += operating
        if draw_month is None and operating >= FOUNDER_DRAW:
            draw_month = m
        months.append(dict(month=m, revenue=round(revenue), operating=round(operating),
                           mrr=round(sum(subs[k] * OFFERS[k]["monthly"] * monthly_mult for k in OFFERS)),
                           subscribers=round(sum(subs.values()), 1), founder_hours=round(hours + founder_build),
                           contractor_hours=round(contractor_hours)))
    return dict(months=months, cumulative_operating=round(cum), month_of_6k_draw=draw_month,
                m12=months[11], m18=months[-1])


def sensitivity():
    base = project("mid")["m18"]["operating"]
    swings = {
        "new setups per month": lambda d: project("mid", setups_override=CASES["mid"]["setups_per_month"] * d),
        "setup prices": lambda d: project("mid", price_mult=d),
        "monthly fees": lambda d: project("mid", monthly_mult=d),
        "monthly churn": lambda d: project("mid", churn_override=CASES["mid"]["churn"] * d),
        "build hours": lambda d: project("mid", hours_mult=d),
    }
    out = {}
    for name, fn in swings.items():
        lo, hi = fn(0.75)["m18"]["operating"], fn(1.25)["m18"]["operating"]
        out[name] = dict(minus_25pct=lo - base, plus_25pct=hi - base)
    return dict(base_m18_operating=base, swings=out)


if __name__ == "__main__":
    result = dict(first_three=first_three(), unit_economics=unit_economics(),
                  cases={k: {kk: v for kk, v in project(k).items() if kk != "months"} for k in CASES},
                  sensitivity=sensitivity())
    print(json.dumps(result, indent=1))
