import type { CategoryInfo, RateCard, ServiceConfig } from "./catalog";

// Request processors for managed services. These are the simulated stand-ins for AI processing (Milestone 4): they
// read the request with fixed rules and call no AI model, so their output is labeled simulated and costs $0. A live
// processor would run through the M2B metered pathway (approval, reservation, ledger) and return the same shape.

export interface QuoteLine {
  description: string;
  quantity: number;
  unit: string;
  unitCents: number;
  amountCents: number;
  /** True when the figure rests on an assumption the customer should confirm. */
  estimated: boolean;
}

export interface ProcessingResult {
  processor: "quote_intake" | "generic";
  simulated: true;
  /** What was found in the request, field by field, with where it came from. */
  extracted: Record<string, { value: string; evidence: string } | null>;
  /** Questions for the person who sent the request, for anything required that is missing. */
  questions: string[];
  /** Assumptions the draft rests on. Each one must be confirmed or corrected before the draft is final. */
  assumptions: string[];
  /** Checks on the request itself (for KELQOR's review). */
  flags: string[];
  draft: Deliverable;
}

export interface Deliverable {
  kind: "quote" | "summary";
  title: string;
  summary: string;
  lines: QuoteLine[];
  totalCents: number;
  /** A reply the customer can send to the person who asked; KELQOR never sends it. */
  reply: string;
  actions: string[];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const NAME = /(?:this is|my name is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/;
const SIGNOFF = /(?:thanks|thank you|regards|best|cheers)[,!.]?\s*\n+\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i;
const COMPANY = /(?:from|with|at)\s+([A-Z][A-Za-z&'.]+(?:\s+[A-Z][A-Za-z&'.]+){0,3})/;
const MATERIALS = ["stainless steel", "stainless", "aluminum", "aluminium", "mild steel", "steel", "brass", "copper", "titanium", "plate", "tube", "angle iron", "sheet metal"];
const THICKNESS = /(\d+\/\d+|\d+(?:\.\d+)?)\s*(?:"|in(?:ch)?(?:es)?\b|mm\b|gauge\b|ga\b)/i;
const DIMENSIONS = /(\d+(?:\.\d+)?)\s*(?:"|in|ft|')?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:"|in|ft|')?/i;
const QUANTITY = /\b(?:qty|quantity)[:\s]+(\d{1,5})\b|\b(\d{1,5})\s+(?:x\s+)?(?:[A-Za-z0-9/"'-]+\s+){0,3}(?:pcs|pieces|units|parts|brackets|panels|plates|signs|gates|railings|handrails|frames|tanks|each|sets|posts|doors|covers|guards|shelves|racks|tables)\b/i;
const DEADLINE = /\b(?:by|before|due|need(?:ed)? (?:it |them )?(?:by|before)?|no later than)\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|next\s+\w+|end of (?:the )?(?:week|month)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)|\bwithin\s+(\d+\s+(?:days?|weeks?))|\b(asap|urgent|rush)\b/i;
const FINISH = /powder[\s-]?coat(?:ed|ing)?(?:\s+(?:in\s+)?([a-z]+))?|\b(painted|galvanized|anodized|raw|unfinished)\b/i;
const JOB_SYNONYMS: Record<string, string[]> = {
  fabrication: ["fabricat", "bracket", "frame", "railing", "handrail", "gate", "stair", "build", "custom"],
  welding: ["weld", "tig", "mig"],
  machining: ["machin", "cnc", "mill", "lathe", "turned"],
  "water jet": ["water jet", "waterjet", "cut out", "cutting", "cut "],
  "powder coating": ["powder"],
  repair: ["repair", "fix", "broken", "crack"],
  installation: ["install", "on site", "on-site", "field"],
};

const found = (value: string | undefined | null, evidence: string) => (value ? { value: value.trim(), evidence: evidence.trim().slice(0, 160) } : null);
const sentenceAround = (text: string, index: number) => {
  const start = Math.max(0, text.lastIndexOf(".", index) + 1, text.lastIndexOf("\n", index) + 1);
  const ends = [text.indexOf(".", index), text.indexOf("\n", index)].filter((n) => n >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
};

function extract(text: string, config: ServiceConfig): ProcessingResult["extracted"] {
  const lower = text.toLowerCase();
  const name = NAME.exec(text)?.[1] ?? SIGNOFF.exec(text)?.[1];
  const email = EMAIL.exec(text)?.[0];
  const phone = PHONE.exec(text)?.[0];
  const company = COMPANY.exec(text)?.[1];
  const contactParts = [name, company ? `(${company})` : null, email, phone].filter(Boolean);
  const types = [...new Set([...config.jobTypes, ...Object.keys(JOB_SYNONYMS)])];
  const jobTypes = types.filter((t) => lower.includes(t) || (JOB_SYNONYMS[t] ?? []).some((w) => lower.includes(w)));
  const q = QUANTITY.exec(text);
  const material = MATERIALS.find((m) => lower.includes(m));
  const thickness = THICKNESS.exec(text);
  const dims = DIMENSIONS.exec(text);
  const deadline = DEADLINE.exec(text);
  const finish = FINISH.exec(text);
  return {
    contact: contactParts.length ? found(contactParts.join(" "), [name, email, phone].filter(Boolean).join(", ")) : null,
    jobType: jobTypes.length ? found(jobTypes.join(", "), sentenceAround(text, lower.indexOf(jobTypes[0].split(" ")[0]))) : null,
    quantity: q ? found(q[1] ?? q[2], q[0]) : null,
    material: material ? found([thickness?.[0], material].filter(Boolean).join(" "), sentenceAround(text, lower.indexOf(material))) : null,
    dimensions: dims ? found(`${dims[1]} x ${dims[2]}`, dims[0]) : null,
    finish: finish ? found(finish[0], finish[0]) : null,
    deadline: deadline ? found(deadline[1] ?? deadline[2] ?? deadline[3], deadline[0]) : null,
  };
}

const QUESTION: Record<string, string> = {
  contact: "Who should we send the quote to, and what's the best phone number or email?",
  jobType: "What kind of work is this: fabrication, welding, machining, cutting, coating, repair or installation?",
  quantity: "How many pieces do you need?",
  material: "What material and thickness should we use (for example 1/4\" mild steel or 3/16\" aluminum)?",
  deadline: "When do you need it finished?",
  dimensions: "What are the main dimensions, or can you send a drawing (DXF or a sketch with measurements)?",
};

function priceQuote(ex: ProcessingResult["extracted"], card: RateCard, assumptions: string[]): QuoteLine[] {
  const lines: QuoteLine[] = [];
  const quantity = Math.max(1, Number(ex.quantity?.value ?? 1) || 1);
  if (!ex.quantity) assumptions.push("Quantity assumed to be 1 until the customer confirms it.");
  const types = (ex.jobType?.value ?? "fabrication").split(", ");
  if (!ex.jobType) assumptions.push("Treated as general fabrication until the customer says what the work is.");
  const primary = types.find((t) => card.jobHours[t] !== undefined) ?? "fabrication";
  const baseHours = card.jobHours[primary] ?? 4;
  // Setup plus a share of time per piece: the shop's own job-hours, scaled gently with the quantity.
  const hours = Math.round((baseHours + 0.25 * (quantity - 1)) * 4) / 4;
  lines.push({ description: `${primary[0].toUpperCase()}${primary.slice(1)} labor (setup and ${quantity} piece${quantity === 1 ? "" : "s"})`, quantity: hours, unit: "hour", unitCents: card.hourlyCents, amountCents: Math.round(hours * card.hourlyCents), estimated: true });
  assumptions.push(`${hours} labor hours estimated from the shop's usual ${baseHours} hours for ${primary} work.`);
  const item = (key: string) => card.items.find((i) => i.key === key);
  if (types.includes("water jet") && item("waterjet_hour")) {
    const h = Math.round((1 + 0.1 * quantity) * 4) / 4;
    const it = item("waterjet_hour")!;
    lines.push({ description: it.label, quantity: h, unit: it.unit, unitCents: it.cents, amountCents: Math.round(h * it.cents), estimated: true });
  }
  if (types.includes("machining") && item("machining_hour") && primary !== "machining") {
    const it = item("machining_hour")!;
    lines.push({ description: it.label, quantity: 2, unit: it.unit, unitCents: it.cents, amountCents: 2 * it.cents, estimated: true });
  }
  if ((types.includes("powder coating") || ex.finish?.value.toLowerCase().includes("powder")) && item("powder_coat_sqft")) {
    const it = item("powder_coat_sqft")!;
    const dims = ex.dimensions?.value.split(" x ").map(Number);
    const sqftEach = dims && dims.every((n) => n > 0) ? Math.max(1, Math.round(((dims[0] * dims[1]) / 144) * 2 * 10) / 10) : 2;
    if (!dims) assumptions.push("Coating area assumed at 2 sq ft per piece until the dimensions are known.");
    const area = Math.round(sqftEach * quantity * 10) / 10;
    lines.push({ description: `${it.label}${ex.finish?.value ? ` (${ex.finish.value})` : ""}`, quantity: area, unit: it.unit, unitCents: it.cents, amountCents: Math.round(area * it.cents), estimated: true });
  }
  lines.push({ description: "Materials", quantity: 1, unit: "lot", unitCents: 0, amountCents: 0, estimated: true });
  assumptions.push("Materials are priced at cost when the material and size are confirmed; shown as $0 until then.");
  return lines;
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function processRequest(category: CategoryInfo, config: ServiceConfig, input: { text: string; from?: string | null }, businessName: string): ProcessingResult {
  const text = input.text.slice(0, 20_000);
  if (category.processor === "quote_intake" && config.rateCard) {
    const extracted = extract(text, config);
    const assumptions: string[] = [];
    const questions = config.requiredFields.filter((f) => !extracted[f] && QUESTION[f]).map((f) => QUESTION[f]);
    if (!extracted.dimensions && !questions.includes(QUESTION.dimensions)) questions.push(QUESTION.dimensions);
    const flags: string[] = [];
    if (!extracted.contact) flags.push("No contact details found: the quote can't be sent until someone is identified.");
    if (/\b(asap|urgent|rush)\b/i.test(text)) flags.push("Marked urgent: check the shop's capacity before promising a date.");
    if (text.length < 80) flags.push("A very short request: expect several follow-up questions.");
    const lines = priceQuote(extracted, config.rateCard, assumptions);
    const subtotal = lines.reduce((n, l) => n + l.amountCents, 0);
    const totalCents = Math.max(config.rateCard.minimumCents, subtotal);
    if (subtotal < config.rateCard.minimumCents) assumptions.push(`The shop minimum of ${dollars(config.rateCard.minimumCents)} applies.`);
    const who = extracted.contact?.value.split(" (")[0].split(" ")[0] ?? "there";
    const reply = [
      `Hi ${who},`,
      "",
      `Thanks for reaching out to ${businessName}. Based on what you've described, our estimate is ${dollars(totalCents)}, before materials.`,
      questions.length ? "To give you a firm quote, could you tell us:" : "We can give you a firm quote once we confirm the details below.",
      ...questions.map((q) => `- ${q}`),
      "",
      `This estimate assumes: ${assumptions.slice(0, 3).join(" ")}`,
      "",
      "Thanks,",
      businessName,
    ].join("\n");
    return {
      processor: "quote_intake",
      simulated: true,
      extracted,
      questions,
      assumptions,
      flags,
      draft: {
        kind: "quote",
        title: `Quote: ${extracted.jobType?.value ?? "custom work"}${extracted.quantity ? `, ${extracted.quantity.value} pieces` : ""}`,
        summary: `${extracted.contact?.value ?? "An unidentified sender"} asked for ${extracted.jobType?.value ?? "work that isn't described clearly"}${extracted.material ? ` in ${extracted.material.value}` : ""}${extracted.deadline ? `, needed ${extracted.deadline.value}` : ""}.`,
        lines,
        totalCents,
        reply,
        actions: [questions.length ? `Ask ${questions.length} follow-up question${questions.length === 1 ? "" : "s"} before the quote is firm.` : "Confirm materials, then send the firm quote.", "Price materials once confirmed."],
      },
    };
  }
  // A generic assistant for categories without a dedicated processor yet: an organized summary and the actions.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
  const actions = sentences.filter((s) => /\b(please|need|must|should|by|deadline|follow up|send|call|review|approve)\b/i.test(s)).slice(0, 6);
  const missing = config.requiredFields.filter((f) => !text.toLowerCase().includes(f.toLowerCase()));
  return {
    processor: "generic",
    simulated: true,
    extracted: { from: found(input.from ?? null, input.from ?? "") },
    questions: missing.map((f) => `Please provide the ${f}.`),
    assumptions: [],
    flags: text.length < 40 ? ["A very short request."] : [],
    draft: {
      kind: "summary",
      title: `${category.name}: ${sentences[0]?.slice(0, 80) ?? "request"}`,
      summary: sentences.slice(0, 3).join(" ").slice(0, 600),
      lines: [],
      totalCents: 0,
      reply: "",
      actions: actions.length ? actions : ["Review the request and decide the next step."],
    },
  };
}
