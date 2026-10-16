import type { CallOutcome, ImageProvider, PaymentProvider, PhoneProvider, SlackProvider, SpeechProvider } from "../hands.ts";

/** Slack Web API with whatever token the person stored (a bot token for channels, a user token for search). */
export class SlackApi implements SlackProvider {
  async call(token: string, method: string, params: Record<string, unknown>) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(params),
    });
    return (await res.json()) as unknown;
  }
}

/** ElevenLabs text to speech. ELEVENLABS_API_KEY; ELEVENLABS_VOICE_ID optional. */
export class ElevenLabsSpeech implements SpeechProvider {
  constructor(
    private apiKey: string,
    private voiceId = "21m00Tcm4TlvDq8ikWAM",
  ) {}
  async speak(input: { text: string; voiceId?: string; pronunciations?: Record<string, string> }) {
    let text = input.text;
    for (const [word, say] of Object.entries(input.pronunciations ?? {})) text = text.split(word).join(say);
    const voice = input.voiceId || this.voiceId;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioBase64: buf.toString("base64"), mimeType: "audio/mpeg", evidence: `elevenlabs:${voice}:${buf.length}` };
  }
}

/** Image generation through OpenRouter's chat completions with image output (IMAGE_MODEL, default Gemini's image model). */
export class OpenRouterImages implements ImageProvider {
  constructor(
    private apiKey: string,
    private model = "google/gemini-2.5-flash-image",
  ) {}
  async generate(input: { prompt: string }) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, modalities: ["image", "text"], messages: [{ role: "user", content: input.prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] };
    const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
    const m = url.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) throw new Error("no image came back");
    return { imageBase64: m[2]!, mimeType: m[1]!, evidence: `openrouter-image:${this.model}` };
  }
}

/** Stripe Issuing: a single-use virtual card for exactly one purchase (STRIPE_SECRET_KEY; needs Issuing enabled). */
export class StripeIssuing implements PaymentProvider {
  constructor(
    private secretKey: string,
    private cardholderId?: string,
  ) {}
  private async api(path: string, body?: Record<string, string>, method = "POST") {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: body ? new URLSearchParams(body) : undefined,
    });
    const j = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Stripe: ${j.error?.message ?? res.status}`);
    return j;
  }
  async issueCard(input: { amountUsd: number; merchant: string; personId: string }) {
    if (!this.cardholderId) throw new Error("STRIPE_CARDHOLDER_ID is not set (create a cardholder in the Stripe dashboard)");
    const card = await this.api("/issuing/cards", {
      cardholder: this.cardholderId,
      currency: "usd",
      type: "virtual",
      status: "active",
      "spending_controls[spending_limits][0][amount]": String(Math.ceil(input.amountUsd * 100)),
      "spending_controls[spending_limits][0][interval]": "all_time",
      "metadata[merchant]": input.merchant,
      "metadata[person]": input.personId,
    });
    const details = (await this.api(`/issuing/cards/${card.id}?expand[]=number&expand[]=cvc`, undefined, "GET")) as {
      number?: string;
      cvc?: string;
      exp_month?: number;
      exp_year?: number;
      last4?: string;
    };
    return {
      cardId: String(card.id),
      last4: details.last4 ?? "",
      details: JSON.stringify({ number: details.number, exp: `${details.exp_month}/${details.exp_year}`, cvc: details.cvc }),
      evidence: `stripe-card:${card.id}`,
    };
  }
  async cancelCard(cardId: string) {
    await this.api(`/issuing/cards/${cardId}`, { status: "canceled" });
  }
}

/**
 * Calls through Vapi (VAPI_API_KEY, VAPI_PHONE_NUMBER_ID): the assistant is created per call with
 * the objective as its prompt; we poll until the call ends and read the summary and transcript.
 * SMS goes through Twilio when TWILIO_* are set, else through the iMessage line's sender when given.
 */
export class VapiPhone implements PhoneProvider {
  constructor(
    private cfg: { apiKey: string; phoneNumberId: string },
    private sms?: { send(to: string, text: string): Promise<{ id: string; evidence: string }> },
  ) {}
  async call(input: { to: string; objective: string; callerName: string; language?: string }): Promise<CallOutcome> {
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: this.cfg.phoneNumberId,
        customer: { number: input.to },
        assistant: {
          name: input.callerName,
          firstMessage: `Hi, this is ${input.callerName}, calling on behalf of a customer.`,
          model: {
            provider: "openai",
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are ${input.callerName}, a polite assistant making a phone call. Objective:\n${input.objective}\nBe brief. When done, say goodbye and end the call.${input.language ? ` Speak ${input.language}.` : ""}`,
              },
            ],
          },
          transcriber: { provider: "deepgram", model: "nova-3", language: input.language ? undefined : "en" },
        },
      }),
    });
    if (!res.ok) throw new Error(`Vapi ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const started = (await res.json()) as { id: string };
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await fetch(`https://api.vapi.ai/call/${started.id}`, { headers: { authorization: `Bearer ${this.cfg.apiKey}` } });
      const j = (await st.json()) as {
        status?: string;
        endedReason?: string;
        startedAt?: string;
        endedAt?: string;
        summary?: string;
        transcript?: string;
        analysis?: { summary?: string };
      };
      if (j.status === "ended") {
        const dur = j.startedAt && j.endedAt ? Math.round((Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000) : 0;
        const status: CallOutcome["status"] = /no-answer|busy/i.test(j.endedReason ?? "")
          ? /busy/i.test(j.endedReason ?? "")
            ? "busy"
            : "no_answer"
          : dur > 0
            ? "completed"
            : "failed";
        const transcript = (j.transcript ?? "")
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ role: (/^(AI|Assistant)/i.test(l) ? "agent" : "party") as "agent" | "party", text: l.replace(/^\w+:\s*/, "") }));
        return {
          callId: started.id,
          status,
          durationSeconds: dur,
          summary: j.analysis?.summary ?? j.summary ?? (transcript.length ? "Call ended; see transcript." : `Call ${j.endedReason ?? "ended"}`),
          transcript,
          evidence: `vapi:${started.id}`,
        };
      }
    }
    return { callId: started.id, status: "failed", durationSeconds: 0, summary: "The call did not end in time.", evidence: `vapi:${started.id}:timeout` };
  }
  async sendSms(input: { to: string; text: string }) {
    if (!this.sms) throw new Error("No SMS sender configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)");
    const r = await this.sms.send(input.to, input.text);
    return { messageId: r.id, evidence: r.evidence };
  }
}

export class TwilioSms {
  constructor(private cfg: { accountSid: string; authToken: string; from: string }) {}
  async send(to: string, text: string) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: this.cfg.from, Body: text }),
    });
    const j = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(`Twilio: ${j.message ?? res.status}`);
    return { id: j.sid ?? "sent", evidence: `twilio:${j.sid}` };
  }
}

/** Calls are a fake until a voice vendor is set; SMS still goes out through Twilio when configured. */
export class SmsOnlyPhone implements PhoneProvider {
  constructor(private sms: TwilioSms) {}
  async call(input: { to: string }): Promise<CallOutcome> {
    return {
      callId: "none",
      status: "failed",
      durationSeconds: 0,
      summary: `No voice vendor is configured (set VAPI_API_KEY and VAPI_PHONE_NUMBER_ID), so ${input.to} was not called.`,
      evidence: "no-voice-vendor",
    };
  }
  async sendSms(input: { to: string; text: string }) {
    const r = await this.sms.send(input.to, input.text);
    return { messageId: r.id, evidence: r.evidence };
  }
}
