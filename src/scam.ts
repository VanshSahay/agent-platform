// "Is this real?" — a plain verdict on a text, email, call or charge, from rules that match how scams actually read.
// Deterministic (no model, no network): the reasons are the evidence. The agent can add a web look-up of a number or domain.
import type { ToolDef } from "./tools";

const RULES: { re: RegExp; reason: string; weight: number }[] = [
  { re: /\b(gift ?cards?|itunes|google play|steam cards?|prepaid cards?)\b/i, reason: "asks for gift cards — no real company, agency or court is paid that way", weight: 5 },
  { re: /\b(wire transfer|western union|moneygram|bitcoin|crypto|cash app|zelle|venmo)\b.*\b(send|pay|transfer)|\b(send|pay|transfer)\b.*\b(wire|western union|moneygram|bitcoin|crypto)\b/i, reason: "wants money by wire or crypto, which can't be reversed", weight: 4 },
  { re: /\b(within|in the next)\s+\d+\s*(minutes?|hours?)\b|\b(immediately|right now|urgent(ly)?|final (notice|warning)|last chance|act now|today only|expires? (today|tonight|soon))\b/i, reason: "pressures you to act right now", weight: 3 },
  { re: /\b(arrest(ed)?|warrant|lawsuit|legal action|suspend(ed)?|frozen|locked|deactivat|terminat(e|ed))\b/i, reason: "threatens arrest, a lawsuit or a locked account", weight: 3 },
  { re: /\b(verify|confirm|update|validate)\b.{0,30}\b(account|identity|password|ssn|social security|card|payment|bank|login|credentials)\b/i, reason: "asks you to 'verify' account or identity details", weight: 3 },
  { re: /\b(irs|social security|ssa|medicare|fbi|dea|sheriff|customs|treasury)\b.{0,80}\b(call|owe|fee|payment|arrest|suspend)/i, reason: "claims to be a government agency demanding payment or a call — they write letters, they don't text", weight: 4 },
  { re: /\b(amazon|apple|microsoft|paypal|netflix|usps|fedex|ups|dhl|chase|wells fargo|bank of america|citi|geek squad|norton|mcafee)\b.{0,80}\b(suspicious|unauthori[sz]ed|charge|refund|renew|hacked|compromised|held|delivery (failed|fee)|redeliver)/i, reason: "a big brand plus a scary charge, refund or delivery problem", weight: 3 },
  { re: /\b(grandma|grandpa|nana|papa|mom|dad)\b.{0,120}\b(jail|accident|hospital|bail|lawyer|don'?t tell|keep (it|this) (quiet|secret)|emergency)\b/i, reason: "the 'family member in trouble, keep it secret' pattern", weight: 5 },
  { re: /\b(remote access|anydesk|teamviewer|download (this|the) (app|tool)|let me (take )?control)\b/i, reason: "asks to install remote-access software", weight: 5 },
  { re: /\b(you'?ve (won|been selected)|congratulations|prize|lottery|sweepstakes|free (gift|money|cruise))\b/i, reason: "an unexpected prize", weight: 3 },
  { re: /\b(your (package|parcel|delivery) (is|was) (held|delayed|undeliverable)|pay (a )?(small|redelivery|customs) fee)\b/i, reason: "a package held for a small fee", weight: 3 },
  { re: /\b(do not|don'?t) (tell|share|discuss)\b|\bkeep (this|it) (between us|confidential|secret)\b/i, reason: "asks you not to tell anyone", weight: 4 },
  { re: /\b(one[- ]time (code|passcode)|otp|verification code)\b.{0,60}\b(read|tell|send|share|give)\b|\b(read|tell|send|share|give)\b.{0,60}\b(one[- ]time (code|passcode)|otp|verification code)\b/i, reason: "wants a one-time code — codes are only ever typed by you, never read to anyone", weight: 5 },
  { re: /\b(dear (customer|user|member|sir|madam))\b/i, reason: "generic greeting instead of your name", weight: 1 },
  { re: /\b(reply|respond|text back)\b.{0,40}\b(stop|yes|y|1)\b|\bclick (here|the link|below)\b/i, reason: "wants a reply or a click rather than you going to the official site yourself", weight: 1 },
];
const BRANDS = ["amazon", "apple", "microsoft", "paypal", "netflix", "usps", "fedex", "ups", "dhl", "chase", "wellsfargo", "bankofamerica", "citi", "irs", "ssa", "medicare", "google", "facebook", "venmo", "zelle"];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rb\.gy|shorturl\.at)\b/i;

/** Domains in the text, and which look like a brand name on a stranger's domain (paypal-secure-login.com, amaz0n.net). */
function linkFindings(text: string) {
  const reasons: string[] = [];
  const hosts = [...new Set([...text.matchAll(/https?:\/\/([^\s/)\]>"']+)|\b((?:[a-z0-9-]+\.)+(?:com|net|org|info|xyz|top|club|online|site|link|co|io|ru|cn|tk|ly|gl|co\.uk|ca|app|shop|cc))\b/gi)].map((m) => (m[1] ?? m[2]).toLowerCase()).filter(Boolean))];
  for (const h of hosts) {
    if (SHORTENERS.test(h)) reasons.push(`uses a link shortener (${h}) so you can't see where it goes`);
    const bare = h.replace(/[^a-z0-9.]/g, "");
    for (const b of BRANDS) {
      const official = new RegExp(`(^|\\.)${b}\\.(com|gov|org|net)$`).test(bare);
      const looksLike = bare.replace(/0/g, "o").replace(/1/g, "l").includes(b) || bare.includes(b.slice(0, 5));
      if (looksLike && !official) { reasons.push(`the link ${h} isn't ${b}'s real website`); break; }
    }
    if (/\.(xyz|top|club|online|site|link|tk|ru|cn|cc)$/.test(bare)) reasons.push(`unusual web address ending for a company (${h})`);
  }
  return reasons;
}

export function checkScam(text: string, extra: { from?: string; phone?: string; kind?: string } = {}) {
  const body = `${extra.from ?? ""} ${text}`;
  const reasons: string[] = [];
  let score = 0;
  for (const r of RULES) if (r.re.test(body)) { reasons.push(r.reason); score += r.weight; }
  const links = linkFindings(body); reasons.push(...links); score += links.length * 3;
  if (extra.from && /@/.test(extra.from)) {
    const dom = extra.from.split("@")[1]?.toLowerCase() ?? "";
    const brand = BRANDS.find((b) => body.toLowerCase().includes(b));
    if (brand && dom && !new RegExp(`(^|\\.)${brand}\\.(com|gov|org|net)$`).test(dom)) { reasons.push(`sent from ${dom}, not from ${brand}`); score += 3; }
  }
  if (extra.phone && /^\+?1?\s*\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(extra.phone) && /\b(irs|social security|medicare|bank|amazon|apple|microsoft)\b/i.test(body)) { reasons.push("a phone number in the message claiming to be an institution — look the real number up yourself, don't use theirs"); score += 2; }
  const verdict = score >= 7 ? "likely a scam" : score >= 3 ? "suspicious" : "nothing obviously wrong";
  const what_to_do = verdict === "nothing obviously wrong"
    ? ["If it asks for money, codes or personal details, treat it as suspicious anyway.", "When in doubt, contact the company through the number on your card or statement, not one in the message."]
    : ["Don't reply, don't click, don't call the number in the message.", "If it names a company or agency, look up their real number yourself and ask them.", "Never read a code, pay with gift cards, or install anything someone on the phone asks for.", "Delete it, or send it to a family member to double-check."];
  return { verdict, score, reasons: [...new Set(reasons)].slice(0, 8), what_to_do, kind: extra.kind ?? "message" };
}

export function registerScamTools(def: (d: ToolDef) => void) {
  def({
    id: "scam.check", description: "\"Is this real?\" — check a text, email, voicemail summary, pop-up or charge for scam signs. Give the message text (and the sender address or phone number if known). Returns a plain verdict with the exact reasons and what to do. Deterministic: say the reasons back to the person in plain words.",
    risk: "read", idempotency: "safe", defaultApproval: "none",
    inputSchema: { type: "object", properties: { text: { type: "string" }, from: { type: "string", description: "email address or name shown" }, phone: { type: "string" }, kind: { type: "string", enum: ["text", "email", "call", "popup", "charge", "letter", "message"] } }, required: ["text"], additionalProperties: false },
    async execute({ text, from, phone, kind }) { return { status: "SUCCEEDED", output: checkScam(String(text), { from, phone, kind }) }; },
  });
}
