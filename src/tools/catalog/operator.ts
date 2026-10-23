import { fmtWhen } from "../../core/clock.ts";
import type { ModelImage } from "../../model/types.ts";
import type { BrowserStep } from "../browser.ts";
import { emptyState, type DocState } from "../../channels/artifacts.ts";
import { askFirst, n, num, obj, s, siteOf, str, type ToolDef, publicUrl } from "../kit.ts";
import { clip, readableRooms, saveArtifact } from "./shared.ts";

/** A click or key press that commits on someone's behalf rather than moving around the site. */
const COMMIT = /\b(confirm|pay|payment|place order|order now|checkout|check out|submit|send|reserve now|book now|complete booking|proceed to pay|purchase|buy)\b/i;

const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

/** Fo's "operator" family: the agent's own housekeeping, artifacts, the browser as an actor, and code. */
export const OPERATOR_TOOLS: ToolDef[] = [
  {
    spec: { name: "get_current_time", description: "The current date and time in the owner's zone and in UTC.", input_schema: obj({}) },
    family: "operator",
    labels: { running: "Checking the time…", done: "Checked the time" },
    sideEffect: false,
    async run(_input, ctx) {
      const zone = ctx.store.getPerson(ctx.agent.ownerId)?.timezone ?? "UTC";
      return { ok: true, content: { now: fmtWhen(ctx.clock.now(), zone), zone, iso: new Date(ctx.clock.now()).toISOString() } };
    },
  },
  {
    spec: {
      name: "load_workspace_context",
      description: "The owner's standing instructions, this chat's priorities, its members, and which services are connected. Use when unsure what this circle is about.",
      input_schema: obj({}),
    },
    family: "operator",
    labels: { running: "Reading the setup…", done: "Read the setup" },
    sideEffect: false,
    async run(_input, ctx) {
      return { ok: true, content: { instructions: ctx.agent.instructions, purpose: ctx.agent.purpose, room: ctx.rooms.describe(ctx.room), connected: ctx.vault.services() } };
    },
  },
  {
    spec: { name: "list_tasks", description: "Delegated tasks in this chat with their status and progress.", input_schema: obj({}) },
    family: "operator",
    labels: { running: "Listing tasks…", done: "Listed tasks" },
    sideEffect: false,
    async run(_input, ctx) {
      return {
        ok: true,
        content: ctx.store
          .listTasks({ roomId: ctx.room.id })
          .map((t) => ({ id: t.id, title: t.title, status: t.status, progress: t.progress, updatedAt: new Date(t.updatedAt).toISOString() })),
      };
    },
  },
  {
    spec: {
      name: "get_task",
      description: "One delegated task in full: brief, status, progress, what was told the room.",
      input_schema: obj({ taskId: str("The task id.") }, ["taskId"]),
    },
    family: "operator",
    labels: { running: "Reading the task…", done: "Read the task" },
    sideEffect: false,
    async run(input, ctx) {
      const t = ctx.store.getTask(s(input.taskId));
      if (!t || t.roomId !== ctx.room.id) return { ok: false, content: "No such task in this chat." };
      return { ok: true, content: t };
    },
  },
  {
    spec: {
      name: "update_task_status",
      description: "Mark a delegated task done, failed or stopped with a one-line reason (update_task records progress; this closes it).",
      input_schema: obj({ taskId: str("The task id."), status: { type: "string", enum: ["done", "failed", "stopped"] }, reason: str("One line.") }, ["taskId", "status"]),
    },
    family: "operator",
    labels: { running: "Closing the task…", done: "Closed the task" },
    sideEffect: false,
    async run(input, ctx) {
      const t = ctx.store.getTask(s(input.taskId));
      if (!t || t.roomId !== ctx.room.id) return { ok: false, content: "No such task in this chat." };
      const status = s(input.status) as "done" | "failed" | "stopped";
      if (!["done", "failed", "stopped"].includes(status)) return { ok: false, content: "status must be done, failed or stopped" };
      if (t.runId) ctx.stopRun(t.runId);
      ctx.tasks.update(t.id, { status, progress: s(input.reason) || `Marked ${status}.` });
      return { ok: true, content: `Task "${t.title}" is ${status}.`, evidence: `task:${t.id}:${status}` };
    },
  },
  {
    spec: { name: "list_scheduled_actions", description: "Everything on this chat's schedule: reminders, repeats and watches, with when they fire next.", input_schema: obj({}) },
    family: "operator",
    labels: { running: "Reading the schedule…", done: "Read the schedule" },
    sideEffect: false,
    async run(_input, ctx) {
      return {
        ok: true,
        content: ctx.store
          .listSchedules({ roomId: ctx.room.id })
          .map((x) => ({ id: x.id, title: x.title, paused: x.paused, next: x.nextRunAt ? new Date(x.nextRunAt).toISOString() : null, runs: x.numRuns, watch: !!x.watch })),
      };
    },
  },
  {
    spec: {
      name: "cancel_scheduled_action",
      description: "Pause a scheduled action or watch so it never fires again. Only the owner, or the person who asked for it, may cancel it.",
      input_schema: obj({ scheduleId: str("The schedule id.") }, ["scheduleId"]),
    },
    family: "operator",
    labels: { running: "Cancelling…", done: "Cancelled a scheduled action" },
    sideEffect: false,
    async run(input, ctx) {
      const sc = ctx.store.getSchedule(s(input.scheduleId));
      if (!sc || sc.roomId !== ctx.room.id) return { ok: false, content: "No such schedule in this chat." };
      const requesterOwns = ctx.requesterId === ctx.agent.ownerId || (sc.createdByRunId && ctx.store.getRun(sc.createdByRunId)?.requesterId === ctx.requesterId);
      if (!requesterOwns) return { ok: false, content: "Only the owner or the person who set it up can cancel it. Ask them." };
      sc.paused = true;
      sc.nextRunAt = undefined;
      ctx.store.putSchedule(sc);
      return { ok: true, content: `"${sc.title}" is cancelled.`, evidence: `schedule:${sc.id}:paused` };
    },
  },
  {
    spec: {
      name: "list_past_sessions",
      description: "The chats you may read (those the requester is in), with the last thing said in each. Use before get_session_transcript.",
      input_schema: obj({ limit: num("At most this many; default 20.") }),
    },
    family: "operator",
    labels: { running: "Listing chats…", done: "Listed chats" },
    sideEffect: false,
    async run(input, ctx) {
      const rooms = readableRooms(ctx).slice(0, Math.min(100, Math.max(1, n(input.limit) ?? 20)));
      return {
        ok: true,
        content: rooms.map((r) => {
          const last = ctx.store.messagesForRoom(r.id, 1).at(-1);
          return { roomId: r.id, name: r.name, kind: r.kind, channel: r.channel, last: last ? { at: new Date(last.at).toISOString(), text: clip(last.text, 160) } : null };
        }),
      };
    },
  },
  {
    spec: {
      name: "get_session_transcript",
      description:
        "What was said in a chat the requester is in, newest last. Private chats of other people are never readable; what a group said stays in that group, so quote it only back into the same chat.",
      input_schema: obj({ roomId: str("The room id, from list_past_sessions."), limit: num("Messages, default 60.") }, ["roomId"]),
    },
    family: "operator",
    labels: { running: "Reading a chat…", done: "Read a chat" },
    sideEffect: false,
    async run(input, ctx) {
      const room = readableRooms(ctx).find((r) => r.id === s(input.roomId));
      if (!room) return { ok: false, content: "Not a chat you can read." };
      const msgs = ctx.store
        .messagesForRoom(room.id, Math.min(300, Math.max(1, n(input.limit) ?? 60)))
        .filter((m) => m.role !== "system" && (m.visibleTo.length === 0 || (ctx.requesterId !== undefined && m.visibleTo.includes(ctx.requesterId))));
      return {
        ok: true,
        content: msgs.map((m) => ({
          at: new Date(m.at).toISOString(),
          who: m.role === "assistant" ? ctx.agent.name : (ctx.store.getPerson(m.authorId)?.displayName ?? m.authorId),
          text: clip(m.text, 600),
        })),
        label: `Read ${room.name}`,
      };
    },
  },
  {
    spec: {
      name: "search_tools",
      description: 'Find tools by what you want to do ("calendar", "send a text", "spreadsheet"). Returns matching tool names and what they do.',
      input_schema: obj({ query: str("What you want to do.") }, ["query"]),
    },
    family: "operator",
    labels: { running: "Finding the right tools…", done: "Found the right tools" },
    sideEffect: false,
    async run(input, ctx) {
      const { TOOLS } = await import("../registry.ts");
      const words = s(input.query)
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2);
      const scored = TOOLS.map((t) => ({ t, score: words.filter((w) => `${t.spec.name} ${t.spec.description} ${t.family}`.toLowerCase().includes(w)).length })).filter(
        (x) => x.score > 0,
      );
      scored.sort((a, b) => b.score - a.score);
      return {
        ok: true,
        content: scored.slice(0, 12).map((x) => ({
          name: x.t.spec.name,
          family: x.t.family,
          description: x.t.spec.description,
          // Not on this run's list because the server lacks the provider: say so instead of letting the model try.
          ...(x.t.needs && !ctx.providers.has(x.t.needs) ? { note: `unavailable on this server: needs the ${x.t.needs} provider` } : {}),
        })),
      };
    },
  },
  {
    spec: {
      name: "write_document",
      description:
        "Make a page people can open and share: a list to tick off, a plan, house rules, a comparison, a letter. Write it as Markdown with headings for sections. Every list line (- item) becomes a shared, tickable item the chat can claim and add to, so write things to do or bring as one item per line. Reply with one line and the link, not the content again.",
      input_schema: obj(
        {
          title: str("Title."),
          markdown: str("The document body in Markdown."),
          share: { type: "string", enum: ["room", "link"], description: "room: members of this chat; link: anyone with the link." },
        },
        ["title", "markdown"],
      ),
    },
    family: "operator",
    labels: { running: "Writing a document…", done: "Wrote a document" },
    sideEffect: false,
    async run(input, ctx) {
      const { id, url } = saveArtifact(ctx, {
        kind: "document",
        title: s(input.title).slice(0, 140),
        data: { markdown: s(input.markdown).slice(0, 200_000) },
        share: s(input.share) === "link" ? "link" : "room",
      });
      return { ok: true, content: { documentId: id, url }, evidence: `artifact:${id}`, label: `Wrote "${s(input.title).slice(0, 40)}"` };
    },
  },
  {
    spec: {
      name: "publish_dashboard",
      description: "Publish a small dashboard (KPIs and charts) people can open: budgets, who owes what, a countdown. Returns its link.",
      input_schema: obj(
        {
          title: str("Title."),
          subtitle: str("One line under the title."),
          kpis: {
            type: "array",
            items: obj({ label: str("Label"), value: str("Value"), delta: str("Change, optional"), trend: { type: "string", enum: ["up", "down", "flat"] } }, ["label", "value"]),
            description: "Up to six numbers to show big.",
          },
          charts: {
            type: "array",
            items: obj(
              {
                type: { type: "string", enum: ["bar", "line", "pie"] },
                title: str("Chart title"),
                labels: list("Category labels"),
                series: { type: "array", items: obj({ name: str("Series name"), data: { type: "array", items: { type: "number" } } }, ["name", "data"]) },
                unit: str("Unit, optional"),
              },
              ["type", "title", "labels", "series"],
            ),
            description: "Charts.",
          },
        },
        ["title"],
      ),
    },
    family: "operator",
    labels: { running: "Publishing a dashboard…", done: "Published a dashboard" },
    sideEffect: false,
    async run(input, ctx) {
      const spec = {
        title: s(input.title),
        subtitle: s(input.subtitle),
        kpis: Array.isArray(input.kpis) ? input.kpis.slice(0, 6) : [],
        charts: Array.isArray(input.charts) ? input.charts.slice(0, 6) : [],
      };
      const { id, url } = saveArtifact(ctx, { kind: "dashboard", title: spec.title.slice(0, 140), data: spec, share: "room" });
      return { ok: true, content: { dashboardId: id, url }, evidence: `artifact:${id}`, label: `Published "${spec.title.slice(0, 40)}"` };
    },
  },
  {
    spec: {
      name: "read_page",
      description:
        "Read a page you published (a list, plan, rota or split): who ticked and claimed what, what was added, and the people in its chat with their ids. Claims are responsibilities waiting to be tracked — call this after a page-edit event, and whenever someone says they will do something from a page.",
      input_schema: obj({ pageId: str("The artifact id, or part of the page's title.") }, ["pageId"]),
    },
    family: "operator",
    labels: { running: "Reading the page…", done: "Read the page" },
    sideEffect: false,
    async run(input, ctx) {
      const q = s(input.pageId).toLowerCase();
      // Only this chat's pages: what a group or a private chat made stays there.
      const a = ctx.store
        .listArtifacts(ctx.agent.id, { roomId: ctx.room.id })
        .find((x) => x.kind === "document" && (x.id === s(input.pageId) || x.title.toLowerCase().includes(q)));
      if (!a) return { ok: false, content: "No such page." };
      const st = (a.data as { state?: DocState }).state ?? emptyState();
      const people = (a.roomId ? ctx.rooms.memberIds(a.roomId) : []).map((id) => ({ id, displayName: ctx.store.getPerson(id)?.displayName ?? id }));
      return {
        ok: true,
        content: {
          id: a.id,
          title: a.title,
          url: `${ctx.publicUrl}/d/${a.id}`,
          claimed: st.claimed,
          checked: st.checked,
          added: st.added,
          people,
        },
      };
    },
  },
  {
    spec: {
      name: "read_dashboard",
      description: "Read a dashboard the assistant published earlier (its numbers and charts), to update it or answer from it.",
      input_schema: obj({ dashboardId: str("The dashboard id, or part of its title.") }, ["dashboardId"]),
    },
    family: "operator",
    labels: { running: "Reading the dashboard…", done: "Read the dashboard" },
    sideEffect: false,
    async run(input, ctx) {
      const q = s(input.dashboardId).toLowerCase();
      const a = ctx.store
        .listArtifacts(ctx.agent.id, { roomId: ctx.room.id })
        .find((x) => x.kind === "dashboard" && (x.id === s(input.dashboardId) || x.title.toLowerCase().includes(q)));
      if (!a) return { ok: false, content: "No such dashboard." };
      return { ok: true, content: { id: a.id, url: `${ctx.publicUrl}/d/${a.id}`, spec: a.data } };
    },
  },
  {
    spec: {
      name: "present_files",
      description: "Hand the chat links to files, images, audio or documents the assistant made (artifacts), by id or recent.",
      input_schema: obj({ ids: list("Artifact ids; empty for the most recent five.") }),
    },
    family: "operator",
    labels: { running: "Gathering files…", done: "Shared files" },
    sideEffect: false,
    async run(input, ctx) {
      const ids = Array.isArray(input.ids) ? (input.ids as unknown[]).map((x) => s(x)).filter(Boolean) : [];
      const arts = ids.length
        ? ids.map((id) => ctx.store.getArtifact(id)).filter((a): a is NonNullable<typeof a> => !!a && a.agentId === ctx.agent.id)
        : ctx.store.listArtifacts(ctx.agent.id, { roomId: ctx.room.id, limit: 5 });
      if (!arts.length) return { ok: true, content: "Nothing to share yet." };
      return { ok: true, content: arts.map((a) => ({ id: a.id, kind: a.kind, title: a.title, url: `${ctx.publicUrl}/d/${a.id}` })) };
    },
  },
  {
    spec: {
      name: "generate_image",
      description: "Make an image from a description (an invitation, a poster, a diagram sketch). Returns a link to it.",
      input_schema: obj({ prompt: str("What the image should show."), title: str("A short title.") }, ["prompt"]),
    },
    family: "operator",
    needs: "images",
    labels: { running: "Making an image…", done: "Made an image" },
    sideEffect: false,
    async run(input, ctx) {
      try {
        const r = await ctx.hands.images.generate({ prompt: s(input.prompt) });
        const { id, url } = saveArtifact(ctx, {
          kind: "image",
          title: (s(input.title) || s(input.prompt)).slice(0, 100),
          data: { base64: r.imageBase64, mimeType: r.mimeType, prompt: s(input.prompt) },
          share: "room",
        });
        return { ok: true, content: { imageId: id, url }, evidence: r.evidence };
      } catch (e) {
        return { ok: false, content: `Could not make the image: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
  {
    spec: {
      name: "analyze_image",
      description: "Look at an image (a photo someone sent, a screenshot, a receipt) and answer a question about it.",
      input_schema: obj({ url: str("Image URL, or an artifact id of an image the assistant has."), question: str("What to look for.") }, ["url", "question"]),
    },
    family: "operator",
    labels: { running: "Looking at the image…", done: "Looked at the image" },
    sideEffect: false,
    async run(input, ctx) {
      const ref = s(input.url);
      // An attachment arrives in the chat as a link like https://host/d/art_x; the id inside it is the image.
      const art = ctx.store.getArtifact(ref.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? ref);
      const image: ModelImage | undefined =
        art && art.kind === "image"
          ? { base64: (art.data as { base64: string }).base64, mediaType: ((art.data as { mimeType?: string }).mimeType ?? "image/png") as "image/png" }
          : /^https?:\/\//.test(ref)
            ? { url: ref }
            : undefined;
      if (!image) return { ok: false, content: "Give an image URL or the id of an image I have." };
      try {
        const answer = await ctx.model.complete({
          system: "Answer the question about the image plainly and briefly. Say what you cannot read.",
          prompt: s(input.question),
          images: [image],
          effort: "low",
          maxTokens: 600,
        });
        return { ok: true, content: answer || "(no answer)", evidence: `vision:${ref.slice(0, 40)}` };
      } catch (e) {
        return { ok: false, content: `Could not read the image: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  },
  {
    spec: {
      name: "browser_use",
      description:
        "Operate a real browser for several steps in one go: open a page, click, type, press keys, scroll, take screenshots, then read the result. Use for booking widgets, forms and sites that need clicks. Never enter passwords or payment details; use connect_account for logins and checkout_cart for paying.",
      input_schema: obj(
        {
          url: str("Where to start."),
          account: str("A connected site (e.g. ubereats.com) to browse as the person, signed in."),
          steps: {
            type: "array",
            description: "In order. Each step is one of: {goto}, {click: selector}, {fill: {selector, value}}, {press: key}, {scroll: up|down}, {waitMs}, {screenshot: true}.",
            items: { type: "object" },
          },
          lookFor: str("Optional: a question to answer from the final screenshot, if you took one."),
        },
        ["url", "steps"],
      ),
    },
    family: "operator",
    needs: "browser",
    labels: { running: "Operating the browser…", done: "Operated the browser", failed: "The browser hit a wall" },
    sideEffect: true,
    async run(input, ctx) {
      const url = s(input.url);
      if (!publicUrl(url)) return { ok: false, content: "url must be a public http:// or https:// address" };
      const steps = (Array.isArray(input.steps) ? input.steps : []).filter((x) => x && typeof x === "object") as BrowserStep[];
      for (const st of steps)
        if ("fill" in st && /password|cvc|card ?number|cvv/i.test(JSON.stringify(st)))
          return { ok: false, content: "I don't type passwords or card details. Use connect_account or checkout_cart." };
      const site = s(input.account) ? siteOf(s(input.account)) : "";
      if (site && !ctx.vault.has(`browser:${site}`)) return { ok: false, content: `${site} is not connected. Call connect_account first.` };
      // Clicking and typing inside someone's signed-in site can order, book or send as them: that asks,
      // as does any use of an account that is not the requester's own.
      const acts = steps.some((st) => "click" in st || "fill" in st || "press" in st);
      if (site && (acts || ctx.requesterId !== ctx.accountOwnerId)) {
        // One yes covers moving around the site for this errand (dates, guests, menus); a step that
        // commits — confirm, pay, order, send — asks again with the exact steps. Asking per click made
        // a booking a dozen approvals long.
        const commits = steps.some((st) => COMMIT.test(JSON.stringify("click" in st || "press" in st ? st : {})));
        const grantKey = `browseok:${ctx.run.id}`;
        const granted = JSON.parse(ctx.store.getKv(grantKey) ?? "[]") as string[];
        if (commits || !granted.includes(site)) {
          const owner = ctx.store.getPerson(ctx.accountOwnerId)?.displayName ?? "the account owner";
          const gate = ctx.gate({
            kind: "action",
            title: commits ? `OK to confirm on ${site} as ${owner}?` : `OK to use ${site} as ${owner} for this?`,
            detail: commits
              ? `${url}\n${steps
                  .map((st) => JSON.stringify(st))
                  .join("\n")
                  .slice(0, 800)}`
              : `To: ${s(ctx.run.requestText) || "the request in this chat"}. I'll move around ${site} signed in as ${owner}, and ask again before anything that books, pays, orders or sends.`,
            key: commits ? ["browser_use", url, site, steps] : ["browser_use", site, "errand"],
          });
          const held = askFirst(gate, "Asked first. Nothing was clicked.");
          if (held) return held;
          if (!commits) ctx.store.setKv(grantKey, JSON.stringify([...granted, site]));
        }
      }
      try {
        const r = site ? await ctx.vault.use(`browser:${site}`, (contextId) => ctx.hands.browser.run({ url, contextId, steps })) : await ctx.hands.browser.run({ url, steps });
        if (!r) return { ok: false, content: `${site} is not connected.` };
        const shots = r.screenshots.map((b64) => saveArtifact(ctx, { kind: "image", title: `Screenshot of ${siteOf(r.url)}`, data: { base64: b64, mimeType: "image/png" } }));
        let looked = "";
        if (s(input.lookFor) && r.screenshots.length)
          looked = await ctx.model
            .complete({
              system: "Answer from the screenshot, briefly.",
              prompt: s(input.lookFor),
              images: [{ base64: r.screenshots.at(-1)!, mediaType: "image/png" }],
              effort: "low",
              maxTokens: 400,
            })
            .catch(() => "");
        return {
          ok: true,
          content: { url: r.url, title: r.title, text: clip(r.text, 6000), screenshots: shots.map((x) => x.url), looked: looked || undefined },
          evidence: r.evidence,
          approach: "browse",
          label: `Used ${siteOf(r.url)}`,
        };
      } catch (e) {
        return { ok: false, content: `Browser failed: ${String((e as Error).message).slice(0, 200)}`, stall: `browser failed at ${url}`, approach: "browse" };
      }
    },
  },
  {
    spec: {
      name: "get_connect_link",
      description:
        "A link the person opens to connect a service in Settings: Google, Slack, an MCP server or an API. Not for website logins (a gym, a shop, a portal): those use connect_account, which opens the sign-in inside the chat.",
      input_schema: obj({ service: str("What to connect, e.g. google, slack, an MCP server, ubereats.com.") }, ["service"]),
    },
    family: "operator",
    labels: { running: "Making a connect link…", done: "Made a connect link" },
    sideEffect: false,
    async run(input, ctx) {
      const service = s(input.service).trim().toLowerCase();
      // Settings connects Google, Slack, MCP servers and APIs. Anything else is a website login, which happens
      // inside the chat: do what connect_account does, guessing the domain from a plain name ("Planet Fitness").
      if (service && !/^(google|gmail|calendar|drive|slack|mcp|api)\b|mcp|api\b/.test(service)) {
        const site = /\.[a-z]{2,}$/.test(service) ? service : `${service.replace(/[^a-z0-9]+/g, "")}.com`;
        const { TOOL_INDEX } = await import("../registry.ts");
        const connect = TOOL_INDEX.get("connect_account");
        if (connect) return connect.run({ site, why: `use ${site} for this request` }, ctx);
      }
      return {
        ok: true,
        content: { url: `${ctx.publicUrl}/#settings/connections`, note: `Open Settings → Connections and connect ${service || "the service"}; then say "done" here.` },
      };
    },
  },
  {
    spec: {
      name: "request_call",
      description:
        "You are stuck on something only a person can do by talking to someone (a dispute, a negotiation, an office that will not deal with an assistant). Ask the owner to make the call themselves, with a brief.",
      input_schema: obj({ who: str("Who to call and the number if known."), brief: str("What needs saying, in order."), why: str("Why the assistant cannot do it.") }, [
        "who",
        "brief",
      ]),
    },
    family: "operator",
    labels: { running: "Asking for a human call…", done: "Asked the owner to call" },
    sideEffect: false,
    async run(input, ctx) {
      const item = ctx.attention.open({
        agentId: ctx.agent.id,
        roomId: ctx.room.id,
        runId: ctx.run.id,
        assigneeId: ctx.agent.ownerId,
        requesterId: ctx.requesterId,
        kind: "action",
        title: `Could you call ${s(input.who)}?`,
        detail: `${s(input.why) ? `${s(input.why)}\n` : ""}What to say: ${s(input.brief)}`,
        options: ["Done", "Can't"],
        ttlMs: 3 * 24 * 60 * 60 * 1000,
      });
      return {
        ok: true,
        content: "Asked the owner to make the call; waiting for them.",
        waitingOn: item,
        roomNotice: ctx.requesterId === ctx.agent.ownerId ? undefined : `I've asked ${ctx.store.getPerson(ctx.agent.ownerId)?.displayName ?? "the owner"} to make that call.`,
      };
    },
  },
];
