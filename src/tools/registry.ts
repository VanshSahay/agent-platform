import { fmtWhen } from "../core/clock.ts";
import type { ApproachKind, AttentionKind, Id, Task } from "../core/types.ts";
import type { ToolSpec } from "../model/types.ts";
import { askFirst, describeOutreach, n, num, obj, parseOutreach, s, siteOf, str, type ToolDef } from "./kit.ts";
import { CATALOG_TOOLS } from "./catalog/index.ts";

export type { GateDecision, ToolContext, ToolDef, ToolFamily, ToolResult } from "./kit.ts";
export { siteOf } from "./kit.ts";

// ----------------------------------------------------------------------------

export const CORE_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "plan",
      description:
        "Write or replace the plan for this request before doing multi-step work. Each step names the approach you will try first; fallbacks are filled in automatically (search, ask the group, call, ask a community with permission, ask a person). Keep steps concrete.",
      input_schema: obj(
        {
          goal: str("What done looks like, in one sentence."),
          steps: {
            type: "array",
            items: obj(
              {
                text: str("The step."),
                approach: { type: "string", enum: ["search", "ask_room", "ask_person", "call", "community_post", "browse", "wait"] },
              },
              ["text", "approach"],
            ),
          },
        },
        ["goal", "steps"],
      ),
    },
    family: "plan",
    labels: { running: "Planning…", done: "Made a plan" },
    sideEffect: false,
    async run(input, ctx) {
      const steps = Array.isArray(input.steps) ? (input.steps as { text: string; approach: ApproachKind }[]) : [];
      if (!steps.length) return { ok: false, content: "A plan needs at least one step." };
      const plan = ctx.planner.create(ctx.run.id, s(input.goal), steps);
      return { ok: true, content: ctx.planner.describe(plan) };
    },
  },
  {
    spec: {
      name: "revise_plan",
      description:
        "Rewrite the plan from what you have learned: a step stalled, a source was a dead end, or the evidence points somewhere better. Say in one line what you learned, then give the remaining steps. Finished steps are kept; the rest is replaced. Do this instead of repeating a failing approach.",
      input_schema: obj(
        {
          evidence: str("What you learned that changes the course, one line."),
          steps: {
            type: "array",
            items: obj(
              {
                text: str("The step."),
                approach: { type: "string", enum: ["search", "ask_room", "ask_person", "call", "community_post", "browse", "wait"] },
              },
              ["text", "approach"],
            ),
          },
        },
        ["evidence", "steps"],
      ),
    },
    family: "plan",
    labels: { running: "Re-planning…", done: "Revised the plan" },
    sideEffect: false,
    async run(input, ctx) {
      const steps = Array.isArray(input.steps) ? (input.steps as { text: string; approach: ApproachKind }[]) : [];
      if (!steps.length) return { ok: false, content: "A revision needs at least one step." };
      const revised = ctx.planner.revise(ctx.run.id, s(input.evidence), steps);
      if (!revised) return { ok: false, content: "There is no plan to revise yet; call plan first." };
      return { ok: true, content: ctx.planner.describe(revised) };
    },
  },
  {
    spec: {
      name: "web_search",
      description:
        "Search the web. Use for businesses, hours, prices, how-tos and anything public. Returns titles and URLs, with a snippet when the engine has one; read the page with browse_page before repeating a price, an hour or a number.",
      input_schema: obj({ query: str("Search query."), near: str("Optional place to bias results, e.g. a city.") }, ["query"]),
    },
    family: "search",
    labels: { running: "Searching the web…", done: "Searched the web" },
    sideEffect: false,
    async run(input, ctx) {
      const r = await ctx.hands.search.search(s(input.query), { near: s(input.near) || undefined, limit: 8 });
      const label = `Searched: ${s(input.query).slice(0, 60)}`;
      if (!r.results.length) return { ok: true, content: "No results.", evidence: r.evidence, stall: `no results for "${s(input.query)}"`, approach: "search", label };
      return { ok: true, content: r.results, evidence: r.evidence, approach: "search", label };
    },
  },
  {
    spec: {
      name: "browse_page",
      description:
        "Open a web page in a real browser and read it as text (hours, prices, booking forms, listings). Optionally fill one field or click one element first. Never enter passwords or payment details; stop and ask the person instead.",
      input_schema: obj(
        {
          url: str("Absolute URL."),
          account: str("A site the person has connected (e.g. ubereats.com) to browse as them, signed in. Use connect_account first if it is not connected."),
          click: str("CSS selector or text=... selector to click after load, if needed."),
          fill: obj({ selector: str("CSS selector of the field"), value: str("Text to type") }, ["selector", "value"]),
        },
        ["url"],
      ),
    },
    family: "search",
    labels: { running: "Using a website…", done: "Read a web page", failed: "Couldn't load the page" },
    sideEffect: false,
    async run(input, ctx) {
      const url = s(input.url);
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: "url must start with http:// or https://" };
      const fill = input.fill && typeof input.fill === "object" ? (input.fill as { selector?: unknown; value?: unknown }) : undefined;
      const site = s(input.account) ? siteOf(s(input.account)) : "";
      if (site && !ctx.vault.has(`browser:${site}`))
        return { ok: false, content: `${site} is not connected for ${ctx.store.getPerson(ctx.accountOwnerId)?.displayName ?? "this person"}. Call connect_account first.` };
      try {
        const action = { click: s(input.click) || undefined, fill: fill && s(fill.selector) ? { selector: s(fill.selector), value: s(fill.value) } : undefined };
        // The context id is handed to the browser inside vault.use; it never reaches the model.
        const r = site
          ? await ctx.vault.use(`browser:${site}`, (contextId) => ctx.hands.browser.readPage({ url, contextId, action }))
          : await ctx.hands.browser.readPage({ url, action });
        if (!r) return { ok: false, content: `${site} is not connected.` };
        if (!r.text.trim())
          return { ok: true, content: { url: r.url, title: r.title, text: "", links: r.links }, evidence: r.evidence, stall: `empty page at ${url}`, approach: "browse" };
        return {
          ok: true,
          content: { url: r.url, title: r.title, text: r.text, links: r.links.slice(0, 30) },
          evidence: r.evidence,
          approach: "browse",
          label: `Read ${siteOf(url)}`,
        };
      } catch (e) {
        return { ok: false, content: `Could not load ${url}: ${String((e as Error).message).slice(0, 200)}`, stall: `page failed: ${url}`, approach: "browse" };
      }
    },
  },
  {
    spec: {
      name: "connect_account",
      description:
        "Ask the person whose accounts this request uses to sign in to a website inside the chat (a real browser opens in a card; you never see the password). Then browse_page with account: <site> works as them. Use for sites that need their login: ordering, bookings, portals.",
      input_schema: obj({ site: str("The site, e.g. ubereats.com"), why: str("One line on what you will do there.") }, ["site", "why"]),
    },
    family: "people",
    labels: { running: "Opening a sign-in…", done: "Asked for a sign-in" },
    sideEffect: false,
    async run(input, ctx) {
      const site = siteOf(s(input.site));
      if (!site) return { ok: false, content: "Give a site like ubereats.com." };
      if (ctx.vault.has(`browser:${site}`)) return { ok: true, content: `${site} is already connected. Use browse_page with account: "${site}".` };
      if (!ctx.hands.browser.startSignIn)
        return { ok: false, content: "No live browser is connected on this server, so sites that need a login cannot be used yet. Tell the person." };
      const who = ctx.store.getPerson(ctx.accountOwnerId);
      const open = ctx.store
        .listAttention({ roomId: ctx.room.id, status: ["open"] })
        .find((a) => a.kind === "connect_account" && a.card?.site === site && a.assigneeId === ctx.accountOwnerId);
      if (open) return { ok: true, content: `Already waiting for ${who?.displayName ?? "them"} to sign in to ${site}.`, waitingOn: open };
      const live = await ctx.hands.browser.startSignIn({ site });
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: ctx.accountOwnerId,
        requesterId: ctx.requesterId,
        kind: "connect_account",
        title: `Sign in to ${site}`,
        detail: `${ctx.agent.name} needs your ${site} account to: ${s(input.why).replace(/[.\s]+$/, "")}. Sign in inside the chat (on a phone, open the link to the app); ${ctx.agent.name} never sees your password, only the signed-in browser.`,
        card: { kind: "connect_account", itemId: "", site, liveViewUrl: live.liveViewUrl, status: "open" },
        ttlMs: 30 * 60 * 1000,
      });
      item.card!.itemId = item.id;
      ctx.store.putAttention(item);
      // The session and context ids are not for the model or the UI; the runtime reads them on Done.
      ctx.store.setKv(`connect:${item.id}`, JSON.stringify({ sessionId: live.sessionId, contextId: live.contextId, site, personId: ctx.accountOwnerId }));
      const notice = ctx.requesterId && ctx.requesterId !== ctx.accountOwnerId ? `I've asked ${who?.displayName ?? "the account owner"} to sign in to ${site}.` : undefined;
      return {
        ok: true,
        content: `Waiting for ${who?.displayName ?? "them"} to sign in to ${site} in the chat. Nothing else happens until they press Done.`,
        waitingOn: item,
        roomNotice: notice,
      };
    },
  },
  {
    spec: {
      name: "find_person",
      description:
        "Look up someone the assistant knows: a member of any chat it is in. Matches on name, email or phone. Returns who they are and which chats you share; a phone number only when the request is from them or from the owner.",
      input_schema: obj({ query: str("A name, part of a name, an email or a phone number.") }, ["query"]),
    },
    family: "people",
    labels: { running: "Looking up people…", done: "Looked up people" },
    sideEffect: false,
    async run(input, ctx) {
      const q = s(input.query).trim().toLowerCase();
      if (q.length < 2) return { ok: false, content: "Give at least two characters." };
      const rooms = ctx.store.listRooms(ctx.agent.id);
      const seen = new Map<Id, { id: Id; name: string; rooms: string[]; phone?: string; email?: string }>();
      for (const room of rooms) {
        for (const id of ctx.rooms.memberIds(room.id)) {
          const p = ctx.store.getPerson(id);
          if (!p) continue;
          const hay = [p.displayName, p.email ?? "", p.phoneE164 ?? ""].join(" ").toLowerCase();
          if (!hay.includes(q)) continue;
          const hit = seen.get(id) ?? { id, name: p.displayName, rooms: [] };
          if (room.kind === "group") hit.rooms.push(room.name);
          const mayContact = ctx.requesterId === id || ctx.requesterId === ctx.agent.ownerId;
          if (mayContact) {
            hit.phone = p.phoneE164;
            hit.email = p.email;
          }
          seen.set(id, hit);
        }
      }
      const out = [...seen.values()].slice(0, 10);
      if (!out.length)
        return { ok: true, content: `Nobody matching "${s(input.query)}" in the chats I'm in. Ask the room, or ask the owner to add them.`, label: `Looked up: ${s(input.query)}` };
      return { ok: true, content: out, label: `Looked up: ${s(input.query)}` };
    },
  },
  {
    spec: {
      name: "add_member",
      description:
        "Add someone to this chat: 'add my sister Mia, +1 415 555 0101' or 'add Sam, sam@example.com'. A phone or email lets their texts or sign-in land on them. Owner only; others are told to ask the owner. Guests are served through the owner; members can be trusted with their own accounts later.",
      input_schema: obj(
        { name: str("Their name."), phone: str("Phone in E.164, optional."), email: str("Email, optional."), role: { type: "string", enum: ["member", "guest"] } },
        ["name"],
      ),
    },
    family: "people",
    labels: { running: "Adding someone…", done: "Added someone to the chat" },
    sideEffect: false,
    async run(input, ctx) {
      if (ctx.requesterId !== ctx.agent.ownerId && ctx.rooms.role(ctx.room.id, ctx.requesterId ?? "") !== "owner")
        return { ok: false, content: `Only ${ctx.store.getPerson(ctx.agent.ownerId)?.displayName ?? "the owner"} can add people to this chat; suggest they ask.` };
      const person = ctx.rooms.findOrCreatePerson({ displayName: s(input.name), email: s(input.email) || undefined, phoneE164: s(input.phone) || undefined });
      if (!person) return { ok: false, content: "Give a name." };
      if (ctx.store.getMembership(ctx.room.id, person.id)) return { ok: true, content: `${person.displayName} is already in this chat.` };
      const role = s(input.role) === "guest" ? "guest" : "member";
      ctx.rooms.addMember(ctx.room.id, person.id, role);
      return {
        ok: true,
        content: `Added ${person.displayName} as ${role}${person.phoneE164 || person.email ? "" : " (no phone or email yet, so their messages cannot be matched to them until one is added)"}.`,
        evidence: `member:${person.id}`,
        label: `Added ${person.displayName}`,
      };
    },
  },
  {
    spec: {
      name: "remove_member",
      description: "Take someone out of this chat. Owner only. The owner cannot be removed.",
      input_schema: obj({ name: str("Member name.") }, ["name"]),
    },
    family: "people",
    labels: { running: "Removing someone…", done: "Removed someone from the chat" },
    sideEffect: false,
    async run(input, ctx) {
      if (ctx.requesterId !== ctx.agent.ownerId && ctx.rooms.role(ctx.room.id, ctx.requesterId ?? "") !== "owner")
        return { ok: false, content: `Only ${ctx.store.getPerson(ctx.agent.ownerId)?.displayName ?? "the owner"} can remove people from this chat.` };
      const who = ctx.findMember(s(input.name));
      if (!who) return { ok: false, content: `No member named "${s(input.name)}".` };
      if (!ctx.rooms.removeMember(ctx.room.id, who.id)) return { ok: false, content: `${who.name} is the owner and stays.` };
      return { ok: true, content: `Removed ${who.name} from this chat.`, evidence: `member-removed:${who.id}`, label: `Removed ${who.name}` };
    },
  },
  {
    spec: {
      name: "ask_room",
      description:
        "Ask the whole group a question and wait for an answer (recommendations, availability, who can do what). The run pauses until someone replies. Use before calling strangers.",
      input_schema: obj({ question: str("The question, in plain words, addressed to the group.") }, ["question"]),
    },
    family: "people",
    labels: { running: "Asking the group…", done: "Asked the group" },
    sideEffect: false,
    async run(input, ctx) {
      const assignee = ctx.requesterId ?? ctx.agent.ownerId;
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: assignee,
        kind: "information",
        title: "Question for the group",
        detail: s(input.question),
        ttlMs: 2 * 24 * 60 * 60 * 1000,
      });
      return { ok: true, content: "Question posted. The run pauses until someone answers.", waitingOn: item, roomNotice: s(input.question), approach: "ask_room" };
    },
  },
  {
    spec: {
      name: "ask_person",
      description:
        "Ask one member a question privately (their own chat with you) and wait. Use for decisions that belong to one person, or anything private. Not for permission to act: place_call, send_sms, post_community and request_purchase ask the right approver themselves. Names must be room members.",
      input_schema: obj(
        {
          person: str("Member name or id."),
          question: str("The question."),
          kind: { type: "string", enum: ["decision", "information", "action"], description: "What you need from them." },
          options: { type: "array", items: { type: "string" }, description: "Choices, for a decision." },
        },
        ["person", "question"],
      ),
    },
    family: "people",
    labels: { running: "Asking someone…", done: "Asked someone" },
    sideEffect: false,
    async run(input, ctx) {
      const who = ctx.findMember(s(input.person));
      if (!who) return { ok: false, content: `No member named "${s(input.person)}" in this room.` };
      const kind = (["decision", "information", "action"].includes(s(input.kind)) ? s(input.kind) : "information") as AttentionKind;
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: who.id,
        requesterId: ctx.requesterId,
        kind,
        title: `${ctx.agent.name} has a question`,
        detail: s(input.question),
        options: Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === "string").slice(0, 8) : undefined,
        ttlMs: 3 * 24 * 60 * 60 * 1000,
      });
      ctx.dm(who.id, s(input.question));
      return {
        ok: true,
        content: `Asked ${who.name} privately. The run pauses until they answer.`,
        waitingOn: item,
        roomNotice: who.id === ctx.requesterId ? undefined : `I've asked ${who.name} about that.`,
        approach: "ask_person",
      };
    },
  },
  {
    spec: {
      name: "wait_for_user_input",
      description:
        "Stop and wait for the person you are serving to answer something only they know: a decision between options, a missing fact, a code, or an action on their side. The run pauses.",
      input_schema: obj(
        {
          question: str("What you need, in one or two sentences."),
          kind: { type: "string", enum: ["decision", "information", "action"] },
          options: { type: "array", items: { type: "string" } },
        },
        ["question", "kind"],
      ),
    },
    family: "people",
    labels: { running: "Waiting for your reply…", done: "Got your reply" },
    sideEffect: false,
    async run(input, ctx) {
      const assignee = ctx.requesterId ?? ctx.agent.ownerId;
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: assignee,
        kind: (["decision", "information", "action"].includes(s(input.kind)) ? s(input.kind) : "information") as AttentionKind,
        title: "Your input is needed",
        detail: s(input.question),
        options: Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === "string").slice(0, 8) : undefined,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      });
      return { ok: true, content: "Waiting.", waitingOn: item, roomNotice: s(input.question), approach: "wait" };
    },
  },
  {
    spec: {
      name: "place_call",
      description:
        "Call a business or person and pursue an objective (ask hours, get a quote, book, confirm). Contacting anyone outside the room needs the owner's OK unless it was disclosed when this was scheduled. Calls outside working hours are held until morning.",
      input_schema: obj(
        {
          to: str("Phone number in E.164."),
          who: str("Who this is (business or person name)."),
          objective: str("What to achieve on the call, including what to ask and what not to agree to."),
          language: str("Language to speak, e.g. 'zh' for Mandarin. Default English."),
        },
        ["to", "who", "objective"],
      ),
    },
    family: "calls",
    needs: "phone",
    labels: { running: "On a call…", done: "Made a call", failed: "Call failed" },
    sideEffect: true,
    async run(input, ctx) {
      const to = e164(s(input.to));
      if (!to) return { ok: false, content: "Give the number in E.164, like +14085550100.", approach: "call" };
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to call ${s(input.who)}?`,
        detail: `${ctx.agent.name} wants to call ${s(input.who)} (${to}) by phone to: ${s(input.objective)}`,
        outreach: { who: s(input.who), how: "phone", contact: to },
        key: ["place_call", to],
      });
      const held = askFirst(gate, "Waiting for the owner's go-ahead. Nothing has been dialed.", { approach: "call" });
      if (held) return held;
      ctx.progress(`Calling ${s(input.who)}…`);
      const r = await ctx.hands.phone.call({ to, objective: s(input.objective), callerName: ctx.agent.name, language: s(input.language) || undefined });
      const stalled = r.status !== "completed";
      return {
        ok: true,
        content: { status: r.status, durationSeconds: r.durationSeconds, summary: r.summary, transcript: r.transcript },
        evidence: r.evidence,
        stall: stalled ? `call to ${s(input.who)}: ${r.status}` : undefined,
        approach: "call",
      };
    },
  },
  {
    spec: {
      name: "send_sms",
      description: "Text a phone number outside the room (a vendor, a clinic). Needs the owner's OK unless disclosed. Held outside working hours.",
      input_schema: obj({ to: str("E.164 number."), who: str("Who this is."), text: str("The message.") }, ["to", "who", "text"]),
    },
    family: "calls",
    needs: "phone",
    labels: { running: "Sending a text…", done: "Sent a text" },
    sideEffect: true,
    async run(input, ctx) {
      const gate = ctx.gate({
        kind: "outreach_approval",
        title: `OK to text ${s(input.who)}?`,
        detail: `${ctx.agent.name} wants to text ${s(input.who)} (${s(input.to)}): "${s(input.text)}"`,
        outreach: { who: s(input.who), how: "sms", contact: s(input.to) },
        key: ["send_sms", s(input.to), s(input.text)],
      });
      const held = askFirst(gate, "Waiting for the owner's go-ahead. Nothing was sent.");
      if (held) return held;
      const r = await ctx.hands.phone.sendSms({ to: s(input.to), text: s(input.text), from: ctx.agent.name });
      return { ok: true, content: { sent: true, messageId: r.messageId }, evidence: r.evidence };
    },
  },
  {
    spec: {
      name: "post_community",
      description:
        "Ask a local or language community for recommendations (Reddit subreddit like 'reddit:r/bayarea', or 'rednote'). Always needs the owner's explicit OK for that community. Say what will be posted. Never include private details about members.",
      input_schema: obj(
        {
          community: str("e.g. reddit:r/sanfrancisco or rednote"),
          title: str("Post title."),
          body: str("Post body. No names, addresses or health details of members."),
          language: str("Language of the post, e.g. zh."),
        },
        ["community", "title", "body"],
      ),
    },
    family: "community",
    needs: "community",
    labels: { running: "Asking a community…", done: "Posted to a community" },
    sideEffect: true,
    async run(input, ctx) {
      const gate = ctx.gate({
        kind: "community_post_approval",
        title: `OK to post on ${s(input.community)}?`,
        detail: `${ctx.agent.name} wants to post publicly on ${s(input.community)}:\n"${s(input.title)}"\n${s(input.body)}`,
        outreach: { who: s(input.community), how: "community_post" },
        key: ["post_community", s(input.community), s(input.title), s(input.body)],
      });
      const held = askFirst(gate, "Waiting for the owner's OK before posting anything public.", { approach: "community_post" });
      if (held) return held;
      const r = await ctx.hands.community.post({ community: s(input.community), title: s(input.title), body: s(input.body), language: s(input.language) || undefined });
      return {
        ok: true,
        content: { postId: r.postId, url: r.url, note: "Check replies later with read_community_replies, or schedule a check." },
        evidence: r.evidence,
        approach: "community_post",
      };
    },
  },
  {
    spec: {
      name: "read_community_replies",
      description: "Read replies to a community post you made earlier.",
      input_schema: obj({ postId: str("The post id returned by post_community.") }, ["postId"]),
    },
    family: "community",
    needs: "community",
    labels: { running: "Reading replies…", done: "Read community replies" },
    sideEffect: false,
    async run(input, ctx) {
      const replies = await ctx.hands.community.replies(s(input.postId));
      if (!replies.length) return { ok: true, content: "No replies yet.", stall: "no community replies yet", approach: "community_post" };
      return { ok: true, content: replies, approach: "community_post" };
    },
  },
  {
    spec: {
      name: "compare_options",
      description: "Lay out candidates side by side (vendors, slots, products) so a person can choose. Produces the table you then show.",
      input_schema: obj(
        {
          title: str("What is being compared."),
          options: {
            type: "array",
            items: obj({ name: str("Name"), price: str("Price or quote"), availability: str("When"), notes: str("Anything that matters") }, ["name"]),
          },
          recommendation: str("Your pick and why, one sentence."),
        },
        ["title", "options"],
      ),
    },
    family: "plan",
    labels: { running: "Comparing options…", done: "Compared options" },
    sideEffect: false,
    async run(input) {
      const opts = Array.isArray(input.options) ? (input.options as Record<string, string>[]) : [];
      const rows = opts.map((o, i) => `${i + 1}. ${o.name}${o.price ? ` — ${o.price}` : ""}${o.availability ? ` — ${o.availability}` : ""}${o.notes ? ` — ${o.notes}` : ""}`);
      const text = `${s(input.title)}\n${rows.join("\n")}${s(input.recommendation) ? `\nSuggestion: ${s(input.recommendation)}` : ""}`;
      return { ok: true, content: text };
    },
  },
  {
    spec: {
      name: "remember",
      description:
        "Note something worth keeping: a rule the owner states, a preference, a person, a store, a decision, a fact, or a lesson (what you taught someone and how far they got). Say who it is about. Notes are dated; newer wins.",
      input_schema: obj(
        {
          type: { type: "string", enum: ["rule", "preference", "person", "schedule", "store", "inventory", "decision", "fact", "lesson"] },
          text: str("One sentence, specific, in the third person."),
          about: str("Member name the note is about, if a person."),
          private: { type: "boolean", description: "True if only this room and the person should ever see it." },
          aliases: { type: "array", items: { type: "string" }, description: "Other words a search should hit." },
        },
        ["type", "text"],
      ),
    },
    family: "memory",
    labels: { running: "Noting that…", done: "Noted" },
    sideEffect: false,
    async run(input, ctx) {
      const about = s(input.about) ? ctx.findMember(s(input.about)) : undefined;
      const type = s(input.type);
      const requesterIsOwner = ctx.requesterId === ctx.agent.ownerId;
      // Rules from the owner take effect now. Everything else is an observation until the nightly pass promotes it.
      const stored = type === "rule" && requesterIsOwner ? "rule" : "observation";
      const scope = about ? "person" : ctx.room.kind === "dm" && ctx.requesterId ? "person" : "room";
      const scopeId = scope === "person" ? (about?.id ?? ctx.requesterId!) : ctx.room.id;
      const m = ctx.memory.write({
        agentId: ctx.agent.id,
        scope: stored === "rule" && !about ? "agent" : scope,
        scopeId: stored === "rule" && !about ? ctx.agent.id : scopeId,
        type: stored,
        text: stored === "observation" ? `[${type}] ${s(input.text)}` : s(input.text),
        aliases: Array.isArray(input.aliases) ? (input.aliases as string[]) : [],
        subjectPersonId: about?.id ?? ctx.requesterId,
        // Private: the note never leaves this chat; otherwise a group may see it (a DM is not a group, see deriveProfile).
        visibleToRooms: input.private ? [] : [ctx.room.id],
        sourceRunId: ctx.run.id,
      });
      return { ok: true, content: `Noted (${m.id}).` };
    },
  },
  {
    spec: {
      name: "search_memory",
      description: "Look up what you know (people, preferences, past decisions, lessons) by keywords. Only returns what this room may see.",
      input_schema: obj({ query: str("Keywords.") }, ["query"]),
    },
    family: "memory",
    labels: { running: "Checking what I know…", done: "Checked my notes" },
    sideEffect: false,
    async run(input, ctx) {
      const hits = ctx.memory.recall(ctx.agent.id, ctx.room, ctx.rooms.memberIds(ctx.room.id), s(input.query));
      if (!hits.length) return { ok: true, content: "Nothing relevant in my notes." };
      return { ok: true, content: hits.map((m) => `${new Date(m.statedAt).toISOString().slice(0, 10)} [${m.type}] ${m.text}`).join("\n") };
    },
  },
  {
    spec: {
      name: "schedule_action",
      description:
        "Schedule yourself to do something later: a reminder, a follow-up call, a recurring check-in. Write the prompt as instructions to your future self and state the premise that must still hold. Name any third party you will contact so the owner is told now.",
      input_schema: obj(
        {
          title: str("Short title."),
          prompt: str("Instructions to your future self."),
          runAt: str("ISO 8601 instant for a one-off."),
          calendar: obj({
            hour: num("0-23"),
            minute: num("0-59"),
            dayOfWeek: { type: "array", items: { type: "number" } },
            everyDays: num("Every N days"),
            everyHours: num("Every N hours, for checks that repeat within a day"),
          }),
          premise: str("What must still be true for this to make sense, e.g. 'the reservation is still unconfirmed'."),
          disclosedOutreach: {
            type: "array",
            items: obj(
              {
                who: str("Name"),
                how: { type: "string", enum: ["phone", "email", "sms", "community_post"] },
                why: str("Purpose"),
                contact: str("Their number (E.164) or email when known; the first one used is bound otherwise."),
              },
              ["who", "how", "why"],
            ),
          },
        },
        ["title", "prompt", "premise"],
      ),
    },
    family: "schedule",
    labels: { running: "Scheduling…", done: "Scheduled" },
    sideEffect: true,
    async run(input, ctx) {
      const zone = ctx.store.getPerson(ctx.agent.ownerId)?.timezone ?? "UTC";
      const runAt = s(input.runAt) ? Date.parse(s(input.runAt)) : undefined;
      const cal = input.calendar && typeof input.calendar === "object" ? (input.calendar as Record<string, unknown>) : undefined;
      if (!runAt && !cal) return { ok: false, content: "Give runAt or calendar." };
      if (runAt !== undefined && !Number.isFinite(runAt)) return { ok: false, content: "runAt is not a valid ISO instant." };
      const outreach = parseOutreach(input.disclosedOutreach);
      // Only the owner may put the agent on a schedule without asking; disclosed outreach is an
      // approval in advance, so anyone else needs the owner's yes for it.
      const role = ctx.requesterId ? ctx.rooms.role(ctx.room.id, ctx.requesterId) : undefined;
      if (role !== "owner") {
        const gate = ctx.gate({
          kind: outreach.length ? "outreach_approval" : "decision",
          title: `OK to schedule "${s(input.title)}"?`,
          detail: `${s(input.prompt)}\nPremise: ${s(input.premise)}${outreach.length ? `\nIt may contact: ${describeOutreach(outreach)}` : ""}`,
          key: ["schedule_action", s(input.title), s(input.prompt), outreach],
        });
        const held = askFirst(gate, "Asked the owner before scheduling.");
        if (held) return held;
      }
      if (outreach.length && ctx.requesterId === ctx.agent.ownerId)
        ctx.dm(ctx.agent.ownerId, `Scheduled "${s(input.title)}" may contact without asking again: ${describeOutreach(outreach)}.`);
      const { Scheduler } = await import("../scheduler/scheduler.ts");
      const sched = Scheduler.createSchedule(ctx.store, ctx.clock, {
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        sessionId: ctx.session.id,
        title: s(input.title),
        prompt: s(input.prompt),
        runAt,
        calendar: cal
          ? {
              hour: n(cal.hour),
              minute: n(cal.minute) ?? 0,
              dayOfWeek: Array.isArray(cal.dayOfWeek) ? (cal.dayOfWeek as number[]) : undefined,
              everyDays: n(cal.everyDays),
              everyHours: n(cal.everyHours),
              timeZone: zone,
            }
          : undefined,
        authorization: {
          basis: "user_requested",
          disclosedOutreach: outreach,
          premise: s(input.premise),
        },
        createdByRunId: ctx.run.id,
      });
      return { ok: true, content: { scheduleId: sched.id, nextRunAt: sched.nextRunAt ? new Date(sched.nextRunAt).toISOString() : null }, evidence: `schedule:${sched.id}` };
    },
  },
  {
    spec: {
      name: "track_commitment",
      description:
        "Record a responsibility someone took on (or you took on) so it is followed up: who, what, for whom, by when. Use for appointments, rides, repairs, bills, anything with a deadline.",
      input_schema: obj(
        {
          title: str("What will be done."),
          owner: str("Member name, or 'me' for yourself."),
          beneficiary: str("Who it is for, if someone else."),
          dueAt: str("ISO 8601 instant, if any."),
          overdue: { type: "boolean", description: "True when the due date is already past on purpose: it is owed now ('Sam owed this since Monday')." },
          detail: str("Context: address, confirmation numbers, what to bring."),
        },
        ["title", "owner"],
      ),
    },
    family: "ledger",
    labels: { running: "Writing it down…", done: "Tracking a responsibility" },
    sideEffect: false,
    async run(input, ctx) {
      const ownerName = s(input.owner).toLowerCase();
      const owner = ownerName === "me" || ownerName === ctx.agent.name.toLowerCase() ? { id: ctx.agent.id, name: ctx.agent.name } : ctx.findMember(s(input.owner));
      if (!owner) return { ok: false, content: `No member named "${s(input.owner)}".` };
      const ben = s(input.beneficiary) ? ctx.findMember(s(input.beneficiary)) : undefined;
      const due = s(input.dueAt) ? Date.parse(s(input.dueAt)) : undefined;
      // A past due date is either something already owed ("since Monday", flagged overdue) or a slipped date
      // (a wrong year, a past weekday) that would nudge at once. Unflagged, say what today is and let the model
      // fix the date or say it is owed.
      const past = due !== undefined && Number.isFinite(due) && due < ctx.clock.now() - 60 * 60 * 1000;
      if (past && input.overdue !== true) {
        const zone = ctx.store.getPerson(ctx.agent.ownerId)?.timezone ?? "UTC";
        return {
          ok: false,
          content: `dueAt ${s(input.dueAt)} is in the past. Now is ${fmtWhen(ctx.clock.now(), zone)} (${new Date(ctx.clock.now()).toISOString()}). Check the year and day and call again; if it really is already owed, call again with overdue: true.`,
        };
      }
      const c = ctx.commitments.track({
        roomId: ctx.room.id,
        agentId: ctx.agent.id,
        ownerId: owner.id,
        beneficiaryId: ben?.id,
        title: s(input.title),
        detail: s(input.detail) || undefined,
        dueAt: due && Number.isFinite(due) ? due : undefined,
        sourceRunId: ctx.run.id,
      });
      return {
        ok: true,
        content: { commitmentId: c.id, owner: owner.name, ...(past ? { overdue: true } : {}), nextNudgeAt: c.nextNudgeAt ? new Date(c.nextNudgeAt).toISOString() : null },
        evidence: `commitment:${c.id}`,
      };
    },
  },
  {
    spec: {
      name: "update_commitment",
      description: "Mark a tracked responsibility done, dropped, blocked, or change its due time or owner.",
      input_schema: obj(
        {
          commitmentId: str("The id."),
          status: { type: "string", enum: ["open", "done", "dropped", "blocked"] },
          dueAt: str("New ISO instant."),
          owner: str("New owner member name."),
          detail: str("Updated context."),
        },
        ["commitmentId"],
      ),
    },
    family: "ledger",
    labels: { running: "Updating…", done: "Updated a responsibility" },
    sideEffect: false,
    async run(input, ctx) {
      const owner = s(input.owner) ? ctx.findMember(s(input.owner)) : undefined;
      const due = s(input.dueAt) ? Date.parse(s(input.dueAt)) : undefined;
      try {
        const c = ctx.commitments.update(s(input.commitmentId), {
          status: s(input.status) ? (s(input.status) as never) : undefined,
          dueAt: due && Number.isFinite(due) ? due : undefined,
          ownerId: owner?.id,
          detail: s(input.detail) || undefined,
        });
        return { ok: true, content: { commitmentId: c.id, status: c.status } };
      } catch (e) {
        return { ok: false, content: String((e as Error).message) };
      }
    },
  },
  {
    spec: {
      name: "request_purchase",
      description:
        "Before paying for anything, declare the amount and what for. Call it first, as soon as you know roughly what it costs, before searching shops. Returns whether you may proceed, or waits for approval. Purchases under the owner's threshold pass automatically; a paused budget blocks.",
      input_schema: obj({ amountUsd: num("Total in USD."), what: str("What is bought."), where: str("Merchant.") }, ["amountUsd", "what", "where"]),
    },
    family: "money",
    labels: { running: "Checking the budget…", done: "Checked the budget" },
    sideEffect: true,
    async run(input, ctx) {
      const amount = n(input.amountUsd) ?? 0;
      if (ctx.agent.trust.spendingPaused) return { ok: true, content: "Spending is paused by the owner. Do not buy; tell them." };
      const gate = ctx.gate({
        kind: "purchase_approval",
        title: `OK to spend $${amount.toFixed(2)}?`,
        detail: `${ctx.agent.name} wants to pay $${amount.toFixed(2)} at ${s(input.where)} for: ${s(input.what)}`,
        money: amount,
        // The yes covers the money (to the next $10) and the merchant; the item's wording lives in the card, so a
        // re-issue that says "$79.99" or paraphrases "what" after the yes does not open a second card.
        key: ["request_purchase", Math.ceil(amount / 10) * 10, s(input.where).toLowerCase()],
      });
      const held = askFirst(gate, "Waiting for approval before paying.");
      if (held) return held;
      return {
        ok: true,
        content: `Approved: ${gate.granted ? gate.reason : ""}. The budget is cleared for $${amount.toFixed(2)} at ${s(input.where)}. Next: search_products and add_to_cart, then checkout_cart, which confirms the budget against the cart but does not place the order: hand the person the item links, the amount and the address to finish, and never say it was ordered.`,
        evidence: `purchase-approved:${amount}`,
      };
    },
  },
  {
    spec: {
      name: "stay_quiet",
      description:
        "End this run without posting anything. Use it on timers, heartbeats, watches and app events when nothing changed, nothing slipped and nobody needs anything. In a group, silence is the default; a message is the exception.",
      input_schema: obj({ reason: str("One line for the record, e.g. 'nothing due before Thursday'.") }, ["reason"]),
    },
    family: "plan",
    labels: { running: "Checking…", done: "Nothing to say" },
    sideEffect: false,
    async run(input) {
      return { ok: true, content: "Staying quiet. The run ends here.", quiet: s(input.reason) || "nothing to report" };
    },
  },
  {
    spec: {
      name: "delegate_task",
      description:
        "Hand long work (many searches, several calls, anything that will take minutes) to a task agent that runs on its own, so you can answer the room now. Write the instructions as a complete brief: the goal, what done looks like, constraints, who to ask. After delegating, reply to the room in one short line that you are on it; the task reports back by itself when done or when it needs someone.",
      input_schema: obj({ title: str("Four to eight words."), instructions: str("The full brief for the task agent.") }, ["title", "instructions"]),
    },
    family: "plan",
    labels: { running: "Handing off…", done: "Handed off to a task" },
    sideEffect: false,
    async run(input, ctx) {
      if (ctx.session.taskId) return { ok: false, content: "You are already a task agent; do the work here instead of delegating again." };
      const task = ctx.tasks.create({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        requesterId: ctx.requesterId,
        title: s(input.title),
        instructions: s(input.instructions),
        createdByRunId: ctx.run.id,
      });
      ctx.delegate(task);
      return {
        ok: true,
        content: `Delegated as task [${task.id}]. It starts when you finish this reply. Tell the room in one short line that you're on it and stop; do not do the work here.`,
        evidence: `task:${task.id}`,
      };
    },
  },
  {
    spec: {
      name: "update_task",
      description:
        "Record progress on a delegated task (one line), optionally telling the room the same line. Task agents call this at each milestone; the main agent can call it to mark a task done or stopped from what a person said.",
      input_schema: obj(
        {
          taskId: str("The task id; inside a task run it defaults to your own task."),
          progress: str("Where it stands, one line."),
          status: { type: "string", enum: ["running", "waiting", "done", "failed", "stopped"], description: "Only when it changes." },
          tellRoom: { type: "boolean", description: "Also post the progress line to the room. Use sparingly: milestones, not every step." },
        },
        ["progress"],
      ),
    },
    family: "plan",
    labels: { running: "Updating the task…", done: "Updated the task" },
    sideEffect: false,
    async run(input, ctx) {
      const id = s(input.taskId) || ctx.run.taskId || "";
      const status = s(input.status) as Task["status"] | "";
      const existing = ctx.store.getTask(id);
      if (!existing || existing.roomId !== ctx.room.id) return { ok: false, content: `No task ${id} in this room.` };
      if (!ctx.run.taskId && (status === "stopped" || status === "done") && existing.runId) ctx.stopRun(existing.runId);
      const t = ctx.tasks.update(id, { progress: s(input.progress), ...(status ? { status } : {}) });
      if (!t) return { ok: false, content: `No task ${id}.` };
      if (input.tellRoom === true) {
        ctx.tasks.delivered(t.id, s(input.progress));
        return { ok: true, content: `Progress recorded and told to the room.`, roomNotice: s(input.progress) };
      }
      return { ok: true, content: "Progress recorded." };
    },
  },
  {
    spec: {
      name: "steer_task",
      description: "Pass a note from the room into a running delegated task (a changed constraint, a new fact, 'stop'). Use the task id from the tasks list.",
      input_schema: obj({ taskId: str("The task id."), note: str("What the task agent should know, in one or two lines.") }, ["taskId", "note"]),
    },
    family: "plan",
    labels: { running: "Passing it on…", done: "Passed a note to the task" },
    sideEffect: false,
    async run(input, ctx) {
      const target = ctx.store.getTask(s(input.taskId));
      if (!target || target.roomId !== ctx.room.id) return { ok: false, content: "No such task in this room." };
      const ok = ctx.steerTask(s(input.taskId), s(input.note));
      return ok
        ? { ok: true, content: "The task agent will see it at its next step." }
        : { ok: false, content: "That task is not running right now (it may be waiting on someone or finished); update_task or a new delegate_task instead." };
    },
  },
  {
    spec: {
      name: "watch_for",
      description:
        "Set an alert rule: check a condition every few hours and act only when it holds, otherwise stay quiet. For 'tell me when the pharmacy confirms', 'if the price drops under $100', 'once Ben replies'. Needs no connection: each check can read your own inbox (email_load_unprocessed), your notes, the ledger, a page or a search. Name any third party you would contact.",
      input_schema: obj(
        {
          title: str("Short title."),
          condition: str("What must be true to act, checkable from notes, the ledger, a page or a search."),
          action: str("What to do when it holds, in one or two lines."),
          everyHours: num("How often to check; 1 to 24."),
          untilDays: num("Stop after this many days (default 14)."),
          disclosedOutreach: {
            type: "array",
            items: obj(
              {
                who: str("Name"),
                how: { type: "string", enum: ["phone", "email", "sms", "community_post"] },
                why: str("Purpose"),
                contact: str("Their number (E.164) or email when known; the first one used is bound otherwise."),
              },
              ["who", "how", "why"],
            ),
          },
        },
        ["title", "condition", "action", "everyHours"],
      ),
    },
    family: "schedule",
    labels: { running: "Setting a watch…", done: "Watching for it" },
    sideEffect: true,
    async run(input, ctx) {
      const every = Math.min(24, Math.max(1, n(input.everyHours) ?? 6));
      const outreach = parseOutreach(input.disclosedOutreach);
      const role = ctx.requesterId ? ctx.rooms.role(ctx.room.id, ctx.requesterId) : undefined;
      if (role !== "owner") {
        const gate = ctx.gate({
          kind: outreach.length ? "outreach_approval" : "decision",
          title: `OK to watch for "${s(input.title)}"?`,
          detail: `Every ${every}h: ${s(input.condition)} → ${s(input.action)}${outreach.length ? `\nIt may contact: ${describeOutreach(outreach)}` : ""}`,
          key: ["watch_for", s(input.title), s(input.condition), s(input.action), outreach],
        });
        const held = askFirst(gate, "Asked the owner before setting the watch.");
        if (held) return held;
      }
      if (outreach.length && ctx.requesterId === ctx.agent.ownerId)
        ctx.dm(ctx.agent.ownerId, `Watch "${s(input.title)}" may contact without asking again: ${describeOutreach(outreach)}.`);
      const zone = ctx.store.getPerson(ctx.agent.ownerId)?.timezone ?? "UTC";
      const untilDays = n(input.untilDays) ?? 14;
      const { Scheduler } = await import("../scheduler/scheduler.ts");
      const sched = Scheduler.createSchedule(ctx.store, ctx.clock, {
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        sessionId: ctx.session.id,
        title: s(input.title),
        prompt: `Check whether this holds: ${s(input.condition)}\nIf it holds: ${s(input.action)} Then tell the room in one line; the watch stops by itself once you report.\nIf it does not hold, call stay_quiet.`,
        calendar: { everyHours: every, timeZone: zone },
        authorization: { basis: "user_requested", disclosedOutreach: outreach, premise: `still worth watching: ${s(input.condition)}` },
        watch: { condition: s(input.condition), action: s(input.action), until: ctx.clock.now() + untilDays * 24 * 3600 * 1000 },
        createdByRunId: ctx.run.id,
      });
      return {
        ok: true,
        content: { scheduleId: sched.id, everyHours: every, firstCheck: sched.nextRunAt ? new Date(sched.nextRunAt).toISOString() : null },
        evidence: `schedule:${sched.id}`,
      };
    },
  },
];

/** A phone number as E.164, taking "(408) 555-0100" as US; anything else that is not +country… is refused. */
export function e164(raw: string): string | undefined {
  const digits = raw.replace(/[^+\d]/g, "");
  const v = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : "";
  return /^\+\d{8,15}$/.test(v) ? v : undefined;
}

/** Every tool that exists: the core set plus the catalogue (Google, operator, knowledge, shopping, voice, contacts, email, MCP). */
export const TOOLS: ToolDef[] = [...CORE_TOOLS, ...CATALOG_TOOLS];
export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.spec.name, t]));

/** The boot-level providers wired in src/main.ts. A tool with `needs` is only offered when its provider is here. */
export type Providers = ReadonlySet<string>;

/**
 * The tools one run may call: the core set, plus catalogue tools whose provider
 * is wired. The list is chosen once per run and never changes mid-run, so the
 * prompt prefix caches; discovery of more happens through search_tools for the
 * next run.
 */
export function toolsForRun(providers: Providers, allow?: string[]): ToolSpec[] {
  return TOOLS.filter((t) => (!t.needs || providers.has(t.needs)) && allowedFor(t, allow)).map((t) => t.spec);
}

/** What every agent keeps whatever its tool list: planning, asking, the ledger, memory, hand-off and silence. */
export const ALWAYS_TOOLS = new Set([
  "plan",
  "revise_plan",
  "ask_room",
  "ask_person",
  "wait_for_user_input",
  "track_commitment",
  "update_commitment",
  "remember",
  "search_memory",
  "delegate_task",
  "update_task",
  "steer_task",
  "stay_quiet",
]);

/** A tool is allowed for an agent with no list, or when its name or family is on the list, or when it is core. */
export function allowedFor(t: ToolDef, allow?: string[]): boolean {
  return !allow || ALWAYS_TOOLS.has(t.spec.name) || allow.includes(t.spec.name) || allow.includes(t.family);
}
