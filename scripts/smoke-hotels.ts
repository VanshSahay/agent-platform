// Live check before deploying price code: `bun run smoke:hotels [city] [countryCode] [checkIn] [checkOut] [stars]`.
// Runs the same two hands hotel_compare uses and prints, per hotel, whether a public price was found. Costs one Apify run (about $0.30).
import { sameHotel } from "../src/tools/catalog/hotels.ts";
import { ApifyHotels } from "../src/tools/providers/public-rates.ts";
import { LiteApi } from "../src/tools/providers/liteapi.ts";

const [city = "Courchevel", countryCode = "FR", checkIn = "2027-01-13", checkOut = "2027-01-17", starsArg] = process.argv.slice(2);
const stars = starsArg ? Number(starsArg) : undefined;
const liteKey = process.env.LITEAPI_API_KEY;
const apifyToken = process.env.APIFY_TOKEN;
if (!liteKey || !apifyToken) {
  console.error("LITEAPI_API_KEY and APIFY_TOKEN must be set in .env");
  process.exit(2);
}
const q = { city, countryCode, checkIn, checkOut, adults: 2, stars };
const t0 = Date.now();
const ours = await new LiteApi(liteKey).rates({ ...q, limit: 20 });
const rows = ours.offers.filter((h) => !stars || !h.stars || h.stars === stars).slice(0, 15);
const classes = [...new Set(rows.map((r) => r.stars).filter((x): x is number => !!x))];
const pub = await new ApifyHotels(apifyToken).search({ ...q, classes });
let matched = 0;
for (const h of rows) {
  const p = pub.offers.find((o) => sameHotel(o.name, h.name));
  if (p) matched++;
  console.log(`${p ? "✓" : "✗"} ${h.name}${h.stars ? ` ${h.stars}★` : ""}: us $${Math.round(h.netUsd)}${p ? ` · public $${p.totalUsd} on ${p.seller}${p.allIn ? "" : " (before taxes & fees)"}${p.listedBelow ? ` · ${p.listedBelow.seller} lists $${p.listedBelow.totalUsd} before taxes & fees` : ""}` : " · no public price"}`);
}
console.log(`\n${matched}/${rows.length} matched · ${pub.offers.length} public hotels from ${pub.source} · classes ${classes.join(",") || "any"} · ${Math.round((Date.now() - t0) / 1000)} s`);
if (matched < rows.length / 2) process.exit(1);
