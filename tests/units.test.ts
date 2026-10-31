import { describe, expect, it } from "vitest";
import { orderEconomics, processingFeeCents, suggestCarePriceCents, suggestPricing } from "@/lib/domain/pricing";
import { availableEvents, canTransition, transition } from "@/lib/domain/state-machine";
import { classifyIntake, templateScope } from "@/lib/scoping/heuristic";
import { lines, parseDollars, safeUrl } from "@/lib/format";
import { SAMPLE_INTAKE } from "./helpers";

describe("pricing", () => {
  it("prices from the hours estimate with buffer and target margin", () => {
    const p = suggestPricing({ hoursLow: 20, hoursHigh: 34 });
    // 27h x $90 x 1.15 = $2,794.50 -> $2,800 payout; / 0.65 = $4,307.69 -> $4,350 price
    expect(p.builderPayoutCents).toBe(280_000);
    expect(p.priceCents).toBe(435_000);
    expect(p.carePriceCents).toBe(29_900);
  });

  it("never quotes below the minimum", () => {
    expect(suggestPricing({ hoursLow: 2, hoursHigh: 3 }).priceCents).toBe(200_000);
  });

  it("clamps care prices", () => {
    expect(suggestCarePriceCents(200_000)).toBe(14_900);
    expect(suggestCarePriceCents(400_000)).toBe(24_900);
    expect(suggestCarePriceCents(5_000_000)).toBe(99_900);
  });

  it("uses Stripe list prices", () => {
    expect(processingFeeCents(400_000, "card")).toBe(11_630);
    expect(processingFeeCents(400_000, "ach")).toBe(500);
    expect(processingFeeCents(400_000, "offline")).toBe(0);
  });

  it("computes contribution and flags thin margins", () => {
    const e = orderEconomics(400_000, 260_000);
    expect(e.grossMarginCents).toBe(140_000);
    expect(e.contributionCents).toBe(140_000 - 500 - 18_000 - 12_000);
    expect(e.warnings).toEqual([]);
    expect(orderEconomics(400_000, 340_000).warnings).toContain("Gross margin is below 25%.");
  });
});

describe("state machine", () => {
  it("allows the happy path in order", () => {
    let s = transition("submitted", "send_quote", "operator");
    s = transition(s, "accept_quote", "client");
    s = transition(s, "record_payment", "system");
    s = transition(s, "start_work", "system");
    s = transition(s, "submit_delivery", "builder");
    s = transition(s, "accept_delivery", "client");
    expect(s).toBe("completed");
  });

  it("rejects skipped steps and wrong roles", () => {
    expect(() => transition("submitted", "accept_quote", "client")).toThrow();
    expect(canTransition("quoted", "send_quote", "client")).toBe(false);
    expect(canTransition("in_progress", "submit_delivery", "client")).toBe(false);
    expect(canTransition("accepted", "record_payment", "client")).toBe(false);
  });

  it("lets clients cancel only before money moves", () => {
    expect(canTransition("accepted", "cancel", "client")).toBe(true);
    expect(canTransition("funded", "cancel", "client")).toBe(false);
    expect(canTransition("funded", "cancel", "operator")).toBe(true);
    expect(availableEvents("completed", "operator")).toEqual([]);
  });
});

describe("template scoper", () => {
  it("classifies a lead-follow-up request", () => {
    expect(classifyIntake(SAMPLE_INTAKE).slug).toBe("lead-response");
  });

  it("falls back to custom and asks questions when details are missing", () => {
    const r = templateScope({ ...SAMPLE_INTAKE, problem: "We need our scheduling tool and payroll tool to agree with each other.", currentTools: "", volume: "", desiredOutcome: "" });
    expect(r.category).toBe("custom");
    expect(r.scope.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(r.scope.clarifyingQuestions.length).toBeGreaterThanOrEqual(3);
  });

  it("honours the client's catalog choice and personalises assumptions", () => {
    const r = templateScope({ ...SAMPLE_INTAKE, templateSlug: "reporting" });
    expect(r.category).toBe("reporting");
    expect(r.scope.assumptions.join(" ")).toContain("HubSpot CRM");
  });
});

describe("input helpers", () => {
  it("only allows http(s) links", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,hi")).toBeNull();
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("parses dollar amounts and line lists", () => {
    expect(parseDollars("$4,350")).toBe(435_000);
    expect(parseDollars("12.5")).toBe(1_250);
    expect(parseDollars("-3")).toBeNull();
    expect(lines("- one\n\n* two\n three ")).toEqual(["one", "two", "three"]);
  });
});
