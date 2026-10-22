import type { HotelOffer, HotelProvider } from "../hands.ts";

/**
 * LiteAPI (Nuitée Connect) hotel rates. One POST returns the rooms and the hotel names; retailRate.total
 * is the net price the account pays with taxes in, suggestedSellingPrice is what the public is seen paying.
 * LITEAPI_API_KEY; a sand_ key answers with live content but cannot book.
 */
export class LiteApi implements HotelProvider {
  constructor(private apiKey: string) {}
  async rates(input: { city: string; countryCode: string; checkIn: string; checkOut: string; adults: number; limit?: number }) {
    const res = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        cityName: input.city,
        countryCode: input.countryCode,
        checkin: input.checkIn,
        checkout: input.checkOut,
        occupancies: [{ adults: input.adults }],
        currency: "USD",
        guestNationality: "US",
        limit: input.limit ?? 10,
      }),
    });
    if (!res.ok) throw new Error(`LiteAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      data?: { hotelId: string; roomTypes?: { rates?: Rate[] }[] }[];
      hotels?: { id: string; name: string; stars?: number; rating?: number; address?: string }[];
      sandbox?: boolean;
    };
    const names = new Map((body.hotels ?? []).map((h) => [h.id, h]));
    const offers: HotelOffer[] = [];
    for (const h of body.data ?? []) {
      // The cheapest room per hotel is the one worth comparing; the rest is noise in a chat.
      const rates = (h.roomTypes ?? []).flatMap((r) => r.rates ?? []);
      const best = rates
        .map(toOffer)
        .filter((o) => o !== undefined)
        .sort((a, b) => a.netUsd - b.netUsd)[0];
      const meta = names.get(h.hotelId);
      if (!best || !meta) continue;
      offers.push({ id: h.hotelId, name: meta.name, stars: meta.stars, rating: meta.rating, address: meta.address, ...best });
    }
    offers.sort((a, b) => a.netUsd - b.netUsd);
    return { offers, evidence: `liteapi:${body.sandbox ? "sandbox:" : ""}${input.city}:${input.checkIn}:${offers.length}` };
  }
}

interface Rate {
  name?: string;
  boardName?: string;
  retailRate?: { total?: { amount: number; currency: string }[]; suggestedSellingPrice?: { amount: number }[]; taxesAndFees?: { included: boolean; amount: number }[] | null };
  cancellationPolicies?: { refundableTag?: string };
}
function toOffer(r: Rate): Omit<HotelOffer, "id" | "name"> | undefined {
  const net = r.retailRate?.total?.[0]?.amount;
  if (typeof net !== "number") return undefined;
  const pub = r.retailRate?.suggestedSellingPrice?.[0]?.amount;
  return {
    room: r.name ?? "Room",
    board: r.boardName ?? "",
    refundable: r.cancellationPolicies?.refundableTag === "RFN",
    netUsd: net,
    // A public price under the net is content noise, not a saving.
    publicUsd: typeof pub === "number" && pub > net ? pub : undefined,
    excludedFeesUsd: (r.retailRate?.taxesAndFees ?? []).filter((t) => !t.included).reduce((s, t) => s + t.amount, 0),
  };
}
