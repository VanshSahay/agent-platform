import type { EmailMessage, EmailProvider } from "../hands.ts";

/**
 * The agent's own mailbox. AgentMail gives it an inbox it can read and send from
 * (AGENTMAIL_API_KEY plus AGENTMAIL_INBOX, e.g. pip@agentmail.to). Resend can only
 * send (RESEND_API_KEY plus EMAIL_FROM), so inbound tools report nothing there.
 */
export class AgentMail implements EmailProvider {
  private seen = new Set<string>();
  constructor(
    private apiKey: string,
    private inbox: string,
  ) {}
  address() {
    return this.inbox;
  }
  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`https://api.agentmail.to/v0${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AgentMail ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
  async send(input: { to: string[]; cc?: string[]; subject: string; text: string; replyToMessageId?: string }) {
    const path = input.replyToMessageId
      ? `/inboxes/${encodeURIComponent(this.inbox)}/messages/${encodeURIComponent(input.replyToMessageId)}/reply`
      : `/inboxes/${encodeURIComponent(this.inbox)}/messages/send`;
    const r = (await this.api(path, { method: "POST", body: JSON.stringify({ to: input.to, cc: input.cc, subject: input.subject, text: input.text }) })) as {
      message_id?: string;
      id?: string;
    };
    const id = r.message_id ?? r.id ?? "sent";
    return { messageId: id, evidence: `agentmail:${id}` };
  }
  private normalise(m: {
    message_id?: string;
    id?: string;
    thread_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    text?: string;
    preview?: string;
    timestamp?: string;
    created_at?: string;
  }): EmailMessage {
    return {
      id: m.message_id ?? m.id ?? "",
      threadId: m.thread_id ?? "",
      from: m.from ?? "",
      to: m.to ?? [],
      subject: m.subject ?? "",
      text: m.text ?? m.preview ?? "",
      at: Date.parse(m.timestamp ?? m.created_at ?? "") || Date.now(),
    };
  }
  async unprocessed() {
    const r = (await this.api(`/inboxes/${encodeURIComponent(this.inbox)}/messages?limit=50&labels=received`)) as { messages?: Parameters<AgentMail["normalise"]>[0][] };
    return (r.messages ?? []).map((m) => this.normalise(m)).filter((m) => !this.seen.has(m.id));
  }
  async thread(threadId: string) {
    const r = (await this.api(`/inboxes/${encodeURIComponent(this.inbox)}/threads/${encodeURIComponent(threadId)}`)) as { messages?: Parameters<AgentMail["normalise"]>[0][] };
    return (r.messages ?? []).map((m) => this.normalise(m));
  }
  async markProcessed(ids: string[]) {
    for (const id of ids) this.seen.add(id);
  }
}

export class ResendMail implements EmailProvider {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}
  address() {
    return this.from;
  }
  async send(input: { to: string[]; cc?: string[]; subject: string; text: string }) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: input.to, cc: input.cc, subject: input.subject, text: input.text }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
    const id = (JSON.parse(text) as { id?: string }).id ?? "sent";
    return { messageId: id, evidence: `resend:${id}` };
  }
  async unprocessed() {
    return [];
  }
  async thread() {
    return [];
  }
  async markProcessed() {}
}
