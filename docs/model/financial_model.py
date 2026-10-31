"""ForgeX year-one financial scenarios.

Every input below is an ASSUMPTION (a hypothesis to test), not a forecast.
Verified inputs: Stripe list prices (stripe.com/pricing, accessed 2026-10-26).
Run:  python docs/model/financial_model.py   (prints JSON; no dependencies)
"""
import json

CARD = lambda p: p * 0.029 + 0.30          # Stripe US card list price
ACH = lambda p: min(p * 0.008, 5.00)       # Stripe ACH Direct Debit, capped at $5

STARTUP_ONE_TIME = 7_500   # entity, contract templates, insurance deposit, brand (range $5k-12k)
FOUNDER_DRAW = 6_000       # optional monthly owner pay, shown as a second break-even test

SCENARIOS = {
    "conservative": dict(
        new_clients=[0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3], repeat_rate=0.05,
        aov=2_500, margin=0.30, card_share=1.0, qa_hours=4, qa_rate=60,
        reserve=0.05, ai_cost=2, care_attach=0.25, care_price=149,
        care_builder_share=0.5, care_churn=0.06, marketing=500, fixed=700),
    "base": dict(
        new_clients=[1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5], repeat_rate=0.08,
        aov=4_000, margin=0.35, card_share=0.4, qa_hours=3, qa_rate=60,
        reserve=0.03, ai_cost=2, care_attach=0.40, care_price=249,
        care_builder_share=0.5, care_churn=0.04, marketing=750, fixed=700),
    "optimistic": dict(
        new_clients=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], repeat_rate=0.12,
        aov=6_000, margin=0.38, card_share=0.3, qa_hours=2, qa_rate=60,
        reserve=0.02, ai_cost=2, care_attach=0.50, care_price=349,
        care_builder_share=0.5, care_churn=0.03, marketing=1_500, fixed=900),
}


def run(s):
    fee = s["card_share"] * CARD(s["aov"]) + (1 - s["card_share"]) * ACH(s["aov"])
    gp_per_order = s["aov"] * s["margin"]
    contrib_per_order = (gp_per_order - fee - s["qa_hours"] * s["qa_rate"]
                         - s["reserve"] * s["aov"] - s["ai_cost"])
    care_gp_each = s["care_price"] * (1 - s["care_builder_share"])
    months, cum_clients, prev_orders, care_active, cash = [], 0.0, 0.0, 0.0, -STARTUP_ONE_TIME
    cash_with_draw = -STARTUP_ONE_TIME
    breakeven_month = breakeven_with_draw = None
    for m, new in enumerate(s["new_clients"], start=1):
        repeat = cum_clients * s["repeat_rate"]
        orders = new + repeat
        cum_clients += new
        care_active = care_active * (1 - s["care_churn"]) + prev_orders * s["care_attach"]
        billings = orders * s["aov"] + care_active * s["care_price"]
        gross_profit = orders * gp_per_order + care_active * care_gp_each
        contribution = orders * contrib_per_order + care_active * care_gp_each
        operating = contribution - s["fixed"] - s["marketing"]
        cash += operating
        cash_with_draw += operating - FOUNDER_DRAW
        if breakeven_month is None and operating >= 0:
            breakeven_month = m
        if breakeven_with_draw is None and operating - FOUNDER_DRAW >= 0:
            breakeven_with_draw = m
        months.append(dict(month=m, orders=round(orders, 2), care_active=round(care_active, 1),
                           billings=round(billings), gross_profit=round(gross_profit),
                           operating=round(operating), cash=round(cash),
                           cash_with_draw=round(cash_with_draw)))
        prev_orders = orders
    year = dict(
        clients=int(cum_clients), orders=round(sum(x["orders"] for x in months), 1),
        billings=sum(x["billings"] for x in months),
        gross_profit=sum(x["gross_profit"] for x in months),
        operating=sum(x["operating"] for x in months),
        care_mrr_m12=round(months[-1]["care_active"] * s["care_price"]),
        cash_end=months[-1]["cash"], cash_end_with_draw=months[-1]["cash_with_draw"],
        min_cash=min(x["cash"] for x in months), min_cash_with_draw=min(x["cash_with_draw"] for x in months),
        breakeven_month=breakeven_month, breakeven_with_draw_month=breakeven_with_draw)
    unit = dict(
        processing_fee=round(fee, 2), gross_profit_per_order=round(gp_per_order),
        contribution_per_order=round(contrib_per_order),
        contribution_pct=round(contrib_per_order / s["aov"] * 100, 1),
        orders_to_cover_fixed=round((s["fixed"] + s["marketing"]) / contrib_per_order, 1),
        orders_to_cover_fixed_and_draw=round((s["fixed"] + s["marketing"] + FOUNDER_DRAW) / contrib_per_order, 1))
    return dict(unit=unit, year=year, months=months)


if __name__ == "__main__":
    out = {name: run(s) for name, s in SCENARIOS.items()}
    # Illustrative comparison: an open marketplace's revenue per client (Upwork FY2025 10-K actuals)
    out["marketplace_benchmark"] = dict(
        upwork_revenue_per_active_client=round(787.8e6 / 785e3),
        new_entrant_revenue_per_client_15pct_take_on_2500_gsv=round(0.15 * 2_500))
    print(json.dumps(out, indent=1))
