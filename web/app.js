// Circle owner app. Plain script, no framework. Every string that lands in HTML goes through esc().
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  people: [],
  rooms: [],
  agents: [],
  me: null,
  room: null,
  page: "chat",
  tab: "input",
  phoneTab: "chat",
  inbox: null,
  suggOffset: 0,
  lastMsgCount: -1,
};
let authToken = null;

// ---------- API ----------
const api = async (path, body, method) => {
  const headers = body ? { "content-type": "application/json" } : {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const r = await fetch(path, { method: method ?? (body ? "POST" : "GET"), headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) {
    status("Sign in required.");
    throw new Error("unauthorized");
  }
  let data = null;
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) throw new Error(data?.error ?? `${r.status} ${r.statusText}`);
  return data;
};
let statusTimer;
function status(text, sticky) {
  $("#status").textContent = text ?? "";
  clearTimeout(statusTimer);
  if (text && !sticky)
    statusTimer = setTimeout(() => {
      if ($("#status").textContent === text) $("#status").textContent = "";
    }, 4000);
}
try {
  state.me = localStorage.getItem("circle.me");
  state.room = localStorage.getItem("circle.room");
} catch {}

// Clerk sign-in, when the server is configured for it. The signed-in person is "You".
async function ensureAuth() {
  if (!window.__CLERK_PK) return true;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://${window.__CLERK_FAPI}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
    s.setAttribute("data-clerk-publishable-key", window.__CLERK_PK);
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  await window.Clerk.load();
  if (!window.Clerk.user) {
    $("#app").innerHTML = '<div id="signin" style="padding:40px;display:grid;place-items:center"></div>';
    window.Clerk.mountSignIn(document.getElementById("signin"));
    window.Clerk.addListener(({ user }) => {
      if (user) location.reload();
    });
    return false;
  }
  authToken = await window.Clerk.session.getToken();
  setInterval(async () => {
    authToken = await window.Clerk.session.getToken();
  }, 50_000);
  const me = await api("/api/me");
  state.me = me?.id ?? null;
  $("#youPick").outerHTML = `<span class="mut" id="youPick">${esc(me?.displayName ?? "")}</span>`;
  return true;
}

// ---------- Lookups and formatting ----------
const roomOf = (id) => state.rooms.find((r) => r.id === id);
const agentFor = (roomId) => {
  const r = roomOf(roomId);
  return state.agents.find((a) => a.id === r?.agentId) ?? state.agents[0];
};
const personOf = (id) => state.people.find((p) => p.id === id);
const nameOf = (id) => personOf(id)?.displayName ?? state.agents.find((a) => a.id === id)?.name ?? id;
const firstName = (id) => nameOf(id).split(" ")[0];
const fmt = (ms) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "");
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const ROLE_WORDS = { owner: "owner", decider: "can decide", member: "member", guest: "guest", cared_for: "cared for" };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TECH = ["low", "medium", "high"];
const AUTO_ALLOW_TOOLS = [
  ["place_call", "Make phone calls"],
  ["send_sms", "Send text messages"],
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const myRooms = () => state.rooms.filter((r) => r.members.some((m) => m.personId === state.me));
const _roleIn = (roomId) => roomOf(roomId)?.members.find((m) => m.personId === state.me)?.role;
const _isPhone = () => matchMedia("(max-width: 820px)").matches;

/** Schedules read as sentences, never as cron. */
function scheduleWords(s) {
  const c = s.calendar;
  if (!c) return s.runAt ? `Once, ${fmt(s.runAt)}` : "Scheduled";
  const time = c.hour !== undefined ? new Date(2000, 0, 1, c.hour, c.minute ?? 0).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  if (c.dayOfWeek?.length) {
    const d = c.dayOfWeek;
    const days = d.length === 7 ? "Every day" : d.length === 5 && !d.includes(0) && !d.includes(6) ? "Weekdays" : d.map((i) => `${DAYS[i]}s`).join(", ");
    return `${days}${time ? ` at ${time}` : ""}`;
  }
  if (c.dayOfMonth?.length) return `Monthly on the ${c.dayOfMonth.join(", ")}${time ? ` at ${time}` : ""}`;
  if (c.everyDays) return `${c.everyDays === 1 ? "Every day" : `Every ${c.everyDays} days`}${time ? ` at ${time}` : ""}`;
  return time ? `Every day at ${time}` : "Scheduled";
}

// ---------- Boot and routing ----------
async function load() {
  const s = await api("/api/state");
  state.agents = s.agents;
  state.rooms = s.rooms;
  const people = new Map();
  for (const p of s.people ?? []) people.set(p.id, p);
  for (const r of s.rooms) for (const m of r.members) if (m.person) people.set(m.person.id, m.person);
  state.people = [...people.values()];
  if (!window.__CLERK_PK && (!state.me || !people.has(state.me))) state.me = state.people[0]?.id ?? null;
  const mine = myRooms();
  if (!state.room || !mine.some((r) => r.id === state.room)) state.room = mine[0]?.id ?? null;
  const meSel = $("#me");
  if (meSel && document.activeElement !== meSel)
    meSel.innerHTML = state.people.map((p) => `<option value="${esc(p.id)}" ${p.id === state.me ? "selected" : ""}>${esc(p.displayName)}</option>`).join("");
  const agent = agentFor(state.room);
  $("#disclaimer").textContent = agent ? `${agent.name} can make mistakes, so double-check.` : "";
  if (!state.agents.length) status("No agent yet. Start with SEED_DEMO=1 or POST /api/agents.", true);
  await Promise.all([renderInbox(), renderThread(), renderLedger()]);
  renderNav();
  if (state.page === "settings") renderSettings();
  if (state.page === "memory") renderMemory();
}

function route() {
  const h = location.hash.replace("#", "");
  state.page = h === "settings" || h === "memory" ? h : "chat";
  $("#pageChat").hidden = state.page !== "chat";
  $("#pageSettings").hidden = state.page !== "settings";
  $("#pageMemory").hidden = state.page !== "memory";
  $$("#pages a").forEach((a) => {
    a.classList.toggle("on", a.dataset.page === state.page);
  });
  if (state.page === "chat") {
    state.phoneTab = "chat";
    placeComposer();
  } else state.phoneTab = "settings";
  setPhoneTab(state.phoneTab);
  if (state.page === "settings") renderSettings();
  if (state.page === "memory") renderMemory();
}
addEventListener("hashchange", route);

function setPhoneTab(tab) {
  state.phoneTab = tab;
  document.body.dataset.tab = tab;
  $$("#tabbar button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === tab);
  });
  if (tab === "chat") placeComposer();
}
$$("#tabbar button").forEach((b) => {
  b.onclick = () => {
    const tab = b.dataset.tab;
    if (tab === "chat") {
      if (state.page !== "chat") location.hash = "chat";
      else setPhoneTab("chat");
      return;
    }
    if (tab === "settings") {
      if (state.page !== "settings") location.hash = "settings";
      else setPhoneTab("settings");
      return;
    }
    setPhoneTab(tab);
  };
});
$("#homeToggle").onclick = () => $("#app").classList.toggle("home-open");
if ($("#me"))
  $("#me").onchange = (e) => {
    state.me = e.target.value;
    try {
      localStorage.setItem("circle.me", state.me);
    } catch {}
    state.lastMsgCount = -1;
    load();
  };
$$(".tabs button").forEach((b) => {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    $$(".tabs button").forEach((x) => {
      x.classList.toggle("on", x === b);
    });
    renderInbox();
  };
});

// ---------- Left nav: rooms and people ----------
function roomFlags(roomId) {
  const inbox = state.inbox;
  if (!inbox) return "";
  if (inbox.needsYou.some((i) => i.roomId === roomId)) return "needs";
  if (inbox.inFlight.some((r) => r.roomId === roomId)) return "busy";
  return "";
}
function renderNav() {
  const mine = myRooms();
  $("#rooms").innerHTML = mine.length
    ? mine
        .map((r) => {
          const f = roomFlags(r.id);
          return `<a href="#chat" data-room="${esc(r.id)}" class="${r.id === state.room ? "on" : ""}"><span class="name">${esc(r.name)}</span>${f ? `<span class="dot ${f}"></span>` : `<span class="sub">${r.kind === "dm" ? "private" : r.members.length}</span>`}</a>`;
        })
        .join("")
    : `<div class="empty">No rooms yet. Make one and add the people in it.</div>`;
  $$("#rooms a").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      state.room = a.dataset.room;
      try {
        localStorage.setItem("circle.room", state.room);
      } catch {}
      state.lastMsgCount = -1;
      if (state.page !== "chat") location.hash = "chat";
      else setPhoneTab("chat");
      load();
    };
  });
  $("#people").innerHTML = state.people.length
    ? state.people
        .map(
          (p) =>
            `<div class="row"><span class="name">${esc(p.displayName)}${p.id === state.me ? ' <span class="tiny">(you)</span>' : ""}</span>${p.id === state.me ? `<button class="link" data-edit="${esc(p.id)}" type="button">Edit</button>` : `<span class="sub">${esc(p.techComfort ? `${p.techComfort} tech` : "")}</span>`}</div>`,
        )
        .join("")
    : `<div class="empty">Nobody yet. Add the people in your circle.</div>`;
  $$("#people [data-edit]").forEach((b) => {
    b.onclick = () => personForm(personOf(b.dataset.edit));
  });
}
$("#newRoom").onclick = () => roomForm();
$("#newPerson").onclick = () => personForm();

function roomForm() {
  const el = $("#roomForm");
  if (el.innerHTML) {
    el.innerHTML = "";
    return;
  }
  const agent = state.agents[0];
  if (!agent) {
    status("Make an agent first.");
    return;
  }
  el.innerHTML = `<form class="form"><h4>New room</h4>
    <div class="field"><label>Name</label><input type="text" name="name" placeholder="Family, Friends, Maple Street…" required /></div>
    <div class="field"><label>Kind</label><select name="kind"><option value="group">Group chat</option><option value="dm">Private chat</option></select></div>
    <div class="field"><span class="lab">Who is in it</span>${state.people
      .map(
        (p) =>
          `<div class="memberrow"><label class="check"><input type="checkbox" name="m" value="${esc(p.id)}" ${p.id === state.me ? "checked" : ""} /> ${esc(p.displayName)}</label><select name="role:${esc(p.id)}">${Object.entries(
            ROLE_WORDS,
          )
            .map(([k, w]) => `<option value="${k}" ${k === (p.id === state.me ? "owner" : "member") ? "selected" : ""}>${esc(w)}</option>`)
            .join("")}</select></div>`,
      )
      .join("")}
    <div class="hint">The owner's accounts pay. Someone who can decide may approve care decisions. Guests are served through you.</div></div>
    <div class="actions"><button class="btn primary" type="submit">Create</button><button class="btn" type="button" data-cancel>Cancel</button><span class="note"></span></div></form>`;
  const form = el.querySelector("form");
  form.querySelector("[data-cancel]").onclick = () => (el.innerHTML = "");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const members = fd.getAll("m").map((personId) => {
      const role = fd.get(`role:${personId}`);
      return { personId, role, consented: role !== "guest" };
    });
    try {
      const room = await api("/api/rooms", { agentId: agent.id, name: fd.get("name"), kind: fd.get("kind"), members });
      el.innerHTML = "";
      state.room = room.id;
      state.lastMsgCount = -1;
      load();
    } catch (err) {
      form.querySelector(".note").textContent = err.message;
      form.querySelector(".note").classList.add("bad");
    }
  };
  form.querySelector("input").focus();
}

function personForm(person) {
  const el = $("#personForm");
  if (el.innerHTML && !person) {
    el.innerHTML = "";
    return;
  }
  const p = person ?? {};
  el.innerHTML = `<form class="form"><h4>${person ? "About you" : "Add a person"}</h4>
    <div class="field"><label>Name</label><input type="text" name="displayName" value="${esc(p.displayName ?? "")}" required /></div>
    <div class="two"><div class="field"><label>Pronouns</label><input type="text" name="pronouns" value="${esc(p.pronouns ?? "")}" placeholder="she/her" /></div>
    <div class="field"><label>Phone</label><input type="tel" name="phoneE164" value="${esc(p.phoneE164 ?? "")}" placeholder="+1…" /></div></div>
    <div class="field"><label>Time zone</label><input type="text" name="timezone" value="${esc(p.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"))}" /></div>
    <div class="field"><label>Comfort with technology</label><select name="techComfort">${TECH.map((t) => `<option value="${t}" ${t === (p.techComfort ?? "medium") ? "selected" : ""}>${t}</option>`).join("")}</select><div class="hint">Low means patient, one step at a time.</div></div>
    <div class="actions"><button class="btn primary" type="submit">${person ? "Save" : "Add"}</button><button class="btn" type="button" data-cancel>Cancel</button><span class="note"></span></div></form>`;
  const form = el.querySelector("form");
  form.querySelector("[data-cancel]").onclick = () => (el.innerHTML = "");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries([...fd.entries()].filter(([, v]) => v !== ""));
    try {
      if (person) await api(`/api/people/${encodeURIComponent(person.id)}`, body, "PATCH");
      else await api("/api/people", body);
      el.innerHTML = "";
      load();
    } catch (err) {
      form.querySelector(".note").textContent = err.message;
      form.querySelector(".note").classList.add("bad");
    }
  };
  form.querySelector("input").focus();
}

// ---------- Home panel ----------
async function renderInbox() {
  const agent = agentFor(state.room);
  const el = $("#inbox");
  const counts = [$("#count"), $("#countHead"), $("#countTab")];
  if (!agent || !state.me) {
    el.innerHTML = `<div class="empty">Nothing here yet.</div>`;
    counts.forEach((c) => {
      c.hidden = true;
    });
    return;
  }
  const inbox = await api(`/api/inbox?personId=${encodeURIComponent(state.me)}&agentId=${encodeURIComponent(agent.id)}`);
  state.inbox = inbox;
  counts.forEach((c) => {
    c.hidden = !inbox.needsYou.length;
    c.textContent = inbox.needsYou.length;
  });
  if (state.tab === "input") {
    el.innerHTML = inbox.needsYou.length
      ? inbox.needsYou
          .map(
            (i) =>
              `<div class="card" data-item="${esc(i.id)}"><h4>${esc(i.title)}</h4><p>${esc(i.detail)}</p><div class="meta">${esc(roomOf(i.roomId)?.name ?? "")}${i.requesterId ? ` · asked by ${esc(nameOf(i.requesterId))}` : ""} · ${fmt(i.createdAt)}</div><div class="row">${(i.options ?? []).map((o) => `<button class="btn ${o === "Yes" ? "primary" : ""}" data-answer="${esc(o)}" type="button">${esc(o)}</button>`).join("")}<button class="btn" data-custom type="button">Reply…</button><button class="btn" data-dismiss type="button">Dismiss</button></div></div>`,
          )
          .join("")
      : `<div class="empty"><strong>Nothing needs you right now.</strong>When ${esc(agent.name)} gets stuck on something only you can answer, it waits here.</div>`;
    const answer = async (id, text) => {
      try {
        await api(`/api/attention/${encodeURIComponent(id)}/resolve`, { answer: text, personId: state.me });
        load();
      } catch (e) {
        status(e.message);
      }
    };
    $$("#inbox [data-answer]").forEach((b) => {
      b.onclick = () => answer(b.closest(".card").dataset.item, b.dataset.answer);
    });
    $$("#inbox [data-custom]").forEach((b) => {
      b.onclick = () => {
        const card = b.closest(".card");
        if (card.querySelector(".reply")) return;
        card.insertAdjacentHTML("beforeend", `<form class="reply"><input placeholder="Your answer…" /><button class="btn primary" type="submit">Send</button></form>`);
        const f = card.querySelector(".reply");
        f.querySelector("input").focus();
        f.onsubmit = (e) => {
          e.preventDefault();
          const t = f.querySelector("input").value.trim();
          if (t) answer(card.dataset.item, t);
        };
      };
    });
    $$("#inbox [data-dismiss]").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/attention/${encodeURIComponent(b.closest(".card").dataset.item)}/dismiss`, {});
        load();
      };
    });
  } else if (state.tab === "radar") {
    const rows = inbox.inFlight
      .map(
        (r) =>
          `<div class="card"><h4>${r.status === "waiting" ? "Waiting on someone" : "Working on it"}</h4><p>${esc(roomOf(r.roomId)?.name ?? "")} · ${esc(triggerWords(r))} · started ${fmt(r.startedAt)}</p><div class="row"><button class="link" data-why="${esc(r.id)}" type="button">Why?</button></div></div>`,
      )
      .concat(
        inbox.radar.map(
          (s) =>
            `<div class="card"><h4>${esc(s.title)}</h4><p>${esc(s.prompt)}</p><div class="meta">${esc(scheduleWords(s))}${s.nextRunAt ? ` · next ${fmt(s.nextRunAt)}` : ""}${s.paused ? " · paused" : ""}</div><div class="row"><button class="btn small" data-pause="${esc(s.id)}" data-paused="${s.paused ? 0 : 1}" type="button">${s.paused ? "Resume" : "Pause"}</button></div></div>`,
        ),
      );
    el.innerHTML = rows.length
      ? rows.join("")
      : `<div class="empty"><strong>${esc(agent.name)}'s schedule is empty.</strong>Ask it to do something later, or to check on something, and it schedules itself. Work in progress shows here too.</div>`;
    $$("#inbox [data-pause]").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/schedules/${encodeURIComponent(b.dataset.pause)}/pause`, { paused: b.dataset.paused === "1" });
        renderInbox();
      };
    });
    $$("#inbox [data-why]").forEach((b) => {
      b.onclick = () => openDrawer(b.dataset.why);
    });
  } else {
    el.innerHTML = inbox.activity.length
      ? inbox.activity
          .map(
            (r) =>
              `<div class="card"><h4>${esc(r.outcome ?? r.failureReason ?? statusWords(r.status))}</h4><div class="meta">${esc(roomOf(r.roomId)?.name ?? "")} · ${esc(statusWords(r.status))} · ${fmt(r.endedAt ?? r.startedAt)}</div><div class="row"><button class="link" data-why="${esc(r.id)}" type="button">Why?</button></div></div>`,
          )
          .join("")
      : `<div class="empty"><strong>Nothing finished yet.</strong>What ${esc(agent.name)} gets done shows up here, in its own words.</div>`;
    $$("#inbox [data-why]").forEach((b) => {
      b.onclick = () => openDrawer(b.dataset.why);
    });
  }
  renderNav();
}
const statusWords = (s) => ({ done: "done", failed: "didn't finish", stopped: "stopped", running: "working", waiting: "waiting" })[s] ?? s;
const triggerWords = (r) =>
  ({
    message: r.requesterId ? `asked by ${nameOf(r.requesterId)}` : "a message",
    scheduled_action: "on schedule",
    heartbeat: "a check-in",
    follow_up: "a follow-up",
    approval: "after an approval",
    steer: "a steer",
  })[r.trigger] ?? r.trigger;

async function renderLedger() {
  const el = $("#ledger");
  if (!state.room) {
    el.innerHTML = "";
    return;
  }
  const cs = (await api(`/api/commitments?roomId=${encodeURIComponent(state.room)}`)).sort(
    (a, b) => (a.status === "open" || a.status === "blocked" ? 0 : 1) - (b.status === "open" || b.status === "blocked" ? 0 : 1) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity),
  );
  el.innerHTML = cs.length
    ? cs
        .map(
          (c) =>
            `<div class="card"><h4>${esc(c.title)}</h4><p>${esc(nameOf(c.ownerId))}${c.beneficiaryId ? ` for ${esc(nameOf(c.beneficiaryId))}` : ""}${c.detail ? ` · ${esc(c.detail)}` : ""}</p><div class="row"><span class="status-chip ${esc(c.status)}">${esc(c.status === "blocked" ? "needs a decision" : c.status)}</span><span class="tiny">${c.dueAt ? `due ${fmt(c.dueAt)}` : "no date"}</span>${c.status === "open" || c.status === "blocked" ? `<button class="btn small" data-done="${esc(c.id)}" type="button" style="margin-left:auto">Mark done</button>` : ""}</div></div>`,
        )
        .join("")
    : `<div class="empty"><strong>No responsibilities yet.</strong>When someone in ${esc(roomOf(state.room)?.name ?? "this room")} says they'll do something, it is tracked here with a name and a time.</div>`;
  $$("#ledger [data-done]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/commitments/${encodeURIComponent(b.dataset.done)}`, { status: "done" });
        renderLedger();
      } catch (e) {
        status(e.message);
      }
    };
  });
}

// ---------- Thread ----------

function stepsHtml(steps, runId) {
  if (!steps?.length) return "";
  const done = steps.filter((s) => s.status === "done").length,
    failed = steps.filter((s) => s.status === "failed").length,
    stopped = steps.filter((s) => s.status === "stopped").length;
  const label = [`Completed ${done} ${done === 1 ? "step" : "steps"}`, failed ? `${failed} failed` : "", stopped ? `${stopped} stopped` : ""].filter(Boolean).join(" · ");
  const mark = (s) =>
    s.status === "failed"
      ? '<span class="x">✕</span>'
      : s.status === "stopped"
        ? '<span class="stop">○</span>'
        : s.verified
          ? '<span class="ok">✓</span>'
          : '<span class="stop">·</span>';
  return `<details class="steps"><summary><span>${esc(label)}</span>${runId ? `<a href="#" class="why" data-why="${esc(runId)}">Why?</a>` : ""}</summary><ul>${steps.map((s) => `<li>${mark(s)}<span>${esc(s.label)}</span></li>`).join("")}</ul></details>`;
}

// Anchor the centred composer to its slot in the welcome layout.
function placeComposer() {
  const slot = $("#slot"),
    composer = $("#composer"),
    chat = $("#pageChat");
  if (!slot || !composer.classList.contains("centered") || chat.hidden) return;
  composer.style.top = `${slot.getBoundingClientRect().top - chat.getBoundingClientRect().top}px`;
}
addEventListener("resize", placeComposer);
function dropComposer() {
  const composer = $("#composer");
  if (!composer.classList.contains("centered")) return;
  const before = composer.getBoundingClientRect().top;
  composer.classList.remove("centered");
  composer.style.top = "";
  const after = composer.getBoundingClientRect().top;
  // The only choreographed motion on the page: the composer slides from the centre to the bottom.
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && before && after)
    composer.animate([{ transform: `translateY(${before - after}px)` }, { transform: "translateY(0)" }], { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
}

async function renderThread() {
  const el = $("#inner");
  const thread = $("#thread");
  const agent = agentFor(state.room);
  const room = roomOf(state.room);
  if (!state.room) {
    el.innerHTML = `<div class="welcome"><h1>${greeting()}.</h1><p>You are not in any room yet. Make one from the Rooms list.</p></div>`;
    return;
  }
  const data = await api(`/api/rooms/${encodeURIComponent(state.room)}/messages?limit=100`);
  const msgs = data.messages ?? data;
  const active = data.activeRun;
  if (!msgs.length) {
    // "Want me to…" cards: what the circle actually has open first, the stock ideas after.
    if (!state.suggFor || state.suggFor !== state.room) {
      state.suggFor = state.room;
      state.sugg = [];
      try {
        if (agent)
          state.sugg = (await api(`/api/suggestions?agentId=${encodeURIComponent(agent.id)}${state.me ? `&personId=${encodeURIComponent(state.me)}` : ""}`))
            .filter((c) => c.roomId === state.room)
            .map((c) => [c.category === "idea" ? "Idea" : c.category === "schedule" ? "Schedule" : c.category === "upcoming" ? "Coming up" : "Follow up", c.prompt, c.title]);
      } catch {
        state.sugg = [];
      }
    }
    const all = state.sugg;
    const picks = all.slice(state.suggOffset, state.suggOffset + 3);
    el.innerHTML = `<div class="welcome"><h1>${greeting()}${state.me ? `, ${esc(firstName(state.me))}` : ""}.</h1><p>${agent ? `${esc(agent.name)} is in ${esc(room?.name ?? "this room")}. Ask for anything: something to find, book, fix, remind, or sort out.` : "No agent in this room yet."}</p><div class="slot" id="slot"></div>${picks.length ? `<div class="sugg">${picks.map((p) => `<button type="button" data-prompt="${esc(p[1])}"><span>${esc(p[0])}</span>${esc(p[2] ?? p[1])}</button>`).join("")}</div>` : ""}${all.length > 3 ? `<button class="another" id="another" type="button">Show others</button>` : ""}</div>`;
    $$(".sugg button").forEach((b) => {
      b.onclick = () => send(b.dataset.prompt);
    });
    const another = $("#another");
    if (another)
      another.onclick = () => {
        state.suggOffset = (state.suggOffset + 3) % all.length;
        renderThread();
      };
    $("#composer").classList.add("centered");
    placeComposer();
    $("#text").placeholder = agent ? `Ask ${agent.name} anything…` : "Message…";
    return;
  }
  dropComposer();
  $("#text").placeholder = agent ? `Message ${agent.name}…` : "Message…";
  let html = msgs
    .map((m) => {
      const who = m.role === "assistant" ? (agent?.name ?? "Agent") : m.role === "system" ? `${agent?.name ?? "Agent"} · ${m.source ?? "note"}` : nameOf(m.authorId);
      const cls = m.role === "user" && m.authorId === state.me ? "me" : m.role === "system" ? "system" : m.source === "notice" ? "notice" : "";
      let body = esc(m.text),
        footer = "";
      const fi = m.role === "assistant" ? m.text.lastIndexOf("\n— ") : -1;
      if (fi > 0) {
        body = esc(m.text.slice(0, fi));
        footer = m.text.slice(fi + 1);
      }
      return `<div class="msg ${cls}"><div class="who">${esc(who)} · ${fmt(m.at)}</div><div class="body">${body}${m.steps?.length ? stepsHtml(m.steps, m.runId) : footer ? `<div class="footer">${esc(footer)}</div>` : ""}</div></div>`;
    })
    .join("");
  if (active && active.status === "running") {
    const running = active.steps.find((s) => s.status === "running");
    html += `<div class="working"><span class="dot"></span><span class="shimmer">${esc(running ? running.label : `${agent?.name ?? "Agent"} is working…`)}</span><a href="#" class="why" data-why="${esc(active.id)}">Why?</a></div>`;
  } else if (active && active.status === "waiting") {
    html += `<div class="working"><span class="dot hold"></span><span>${esc(agent?.name ?? "Agent")} is waiting on someone.</span><a href="#" class="why" data-why="${esc(active.id)}">Why?</a></div>`;
  }
  el.innerHTML = html;
  $$("#inner .why").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDrawer(a.dataset.why);
    };
  });
  if (msgs.length !== state.lastMsgCount) {
    thread.scrollTop = thread.scrollHeight;
    state.lastMsgCount = msgs.length;
  }
}

async function send(text) {
  if (!text || !state.room || !state.me) return;
  $("#text").value = "";
  status("");
  const inner = $("#inner");
  if ($("#composer").classList.contains("centered")) inner.innerHTML = "";
  // Show the message at once; the run follows.
  inner.insertAdjacentHTML(
    "beforeend",
    `<div class="msg me"><div class="who">${esc(nameOf(state.me))}</div><div class="body">${esc(text)}</div></div><div class="working"><span class="dot"></span><span class="shimmer">${esc(agentFor(state.room)?.name ?? "Agent")} is working…</span></div>`,
  );
  dropComposer();
  $("#thread").scrollTop = $("#thread").scrollHeight;
  try {
    await api(`/api/rooms/${encodeURIComponent(state.room)}/messages`, { personId: state.me, text, dedupKey: `${state.me}:${Date.now()}` });
  } catch (e) {
    status(e.message);
  }
  load();
}
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  send($("#text").value.trim());
};

// ---------- The "Why?" drawer: plan, tool calls, timeline, all from records ----------
const PLAN_MARK = {
  done: '<span class="ok">✓</span>',
  active: '<span class="ok">●</span>',
  failed: '<span class="x">✕</span>',
  skipped: '<span class="stop">○</span>',
  pending: '<span class="stop">·</span>',
};
const APPROACH = { search: "search", ask_room: "ask the group", ask_person: "ask someone", call: "call", community_post: "ask a community", browse: "browse", wait: "wait" };
function inputSummary(input) {
  if (input == null) return "";
  if (typeof input !== "object") return String(input);
  const parts = Object.entries(input)
    .filter(([, v]) => v != null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${v}`);
  if (!parts.length) parts.push(...Object.keys(input));
  const s = parts.join(" · ");
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}
function eventWords(e, _run) {
  const d = e.data ?? {};
  switch (e.type) {
    case "started":
      return `Started: ${triggerWords({ trigger: d.trigger, requesterId: d.requesterId })}`;
    case "plan":
      return "Made a plan";
    case "tool_start":
      return d.label ?? d.tool;
    case "tool_end":
      return `${d.label ?? d.tool}${d.status === "failed" ? " (failed)" : d.status === "running" ? " (waiting)" : ""}${d.evidence ? " · evidence kept" : ""}`;
    case "progress":
      return d.text;
    case "gate_opened":
      return `Asked ${nameOf(d.assigneeId)}: ${d.title}`;
    case "gate_resolved":
      return `Answered: ${d.answer}`;
    case "steer_queued":
      return `${nameOf(d.personId)} added: ${d.text}`;
    case "steer_applied":
      return "Took the new message into account";
    case "reply":
      return `Replied${d.steps ? ` after ${d.steps} ${d.steps === 1 ? "step" : "steps"}` : ""}`;
    case "error":
      return d.message ?? "Something went wrong";
    case "done":
      return d.status === "done" ? "Finished" : `${statusWords(d.status)}${d.failureReason ? `: ${d.failureReason}` : ""}`;
    default:
      return "";
  }
}
async function openDrawer(runId) {
  const drawer = $("#drawer"),
    body = $("#drawerBody");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("#drawerTitle").textContent = "Why";
  body.innerHTML = `<div class="mut">Loading…</div>`;
  let d;
  try {
    d = await api(`/api/runs/${encodeURIComponent(runId)}`);
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const agent = state.agents.find((a) => a.id === d.run.agentId) ?? agentFor(state.room);
  $("#drawerTitle").textContent = `Why ${agent?.name ?? "the agent"} did this`;
  const plan = d.plan,
    calls = d.toolCalls ?? [];
  const events = (d.events ?? []).filter((e) => !["delta", "agent_state"].includes(e.type));
  const timing = d.run.endedAt ? `${fmt(d.run.startedAt)} to ${fmtTime(d.run.endedAt)}` : `started ${fmt(d.run.startedAt)}`;
  body.innerHTML = `
    <p class="summary">${esc(roomOf(d.run.roomId)?.name ?? "")} · ${esc(triggerWords(d.run))} · ${esc(statusWords(d.run.status))} · ${esc(timing)}</p>
    ${d.run.outcome ? `<p class="goal">${esc(d.run.outcome)}</p>` : ""}
    <h4>Plan</h4>
    ${plan ? `<p class="goal">${esc(plan.goal)}</p><ul class="plan">${plan.steps.map((s) => `<li class="${esc(s.status)}"><span class="mark">${PLAN_MARK[s.status] ?? ""}</span><span>${esc(s.text)}</span><span class="ap">${esc(APPROACH[s.approach] ?? s.approach)}</span></li>`).join("")}</ul>` : `<div class="empty">No plan was needed; it answered directly.</div>`}
    <h4>What it did</h4>
    ${calls.length ? `<ul class="calls">${calls.map((c) => `<li><div class="top"><span>${c.status === "failed" ? '<span class="x">✕</span>' : c.status === "stopped" ? '<span class="stop">○</span>' : c.status === "running" ? '<span class="stop">…</span>' : '<span class="ok">✓</span>'}</span><span class="lab">${esc(c.status === "running" ? c.labelRunning : c.labelDone)} <span class="mono tiny">${esc(c.name)}</span></span><span class="ev ${c.evidence ? "yes" : ""}">${c.evidence ? "evidence ✓" : "no evidence"}</span></div>${inputSummary(c.input) ? `<div class="in">${esc(inputSummary(c.input))}</div>` : ""}</li>`).join("")}</ul>` : `<div class="empty">No tools were used.</div>`}
    <h4>Timeline</h4>
    ${
      events.length
        ? `<ul class="tl">${events
            .map((e) => {
              const w = eventWords(e, d.run);
              return w
                ? `<li class="${e.type.startsWith("gate") ? "gate" : e.type === "error" ? "err" : ""}"><span class="t">${esc(fmtTime(e.at))}</span><span>${esc(w)}</span></li>`
                : "";
            })
            .join("")}</ul>`
        : `<div class="empty">Nothing recorded yet.</div>`
    }`;
}
function closeDrawer() {
  const d = $("#drawer");
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
}
$("#drawerClose").onclick = closeDrawer;
addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});
document.addEventListener("click", (e) => {
  const d = $("#drawer");
  if (d.classList.contains("open") && !d.contains(e.target) && !e.target.closest("[data-why]")) closeDrawer();
});

// ---------- Settings page ----------
function renderSettings() {
  const el = $("#settings");
  if (el.contains(document.activeElement)) return; // do not clobber what the person is typing
  const agent = agentFor(state.room);
  if (!agent) {
    el.innerHTML = `<h1>Settings</h1><div class="empty">No agent yet.</div>`;
    return;
  }
  const t = agent.trust ?? {};
  const deployed = !!agent.deployedAt;
  el.innerHTML = `<div class="headrow"><h1>${esc(agent.name)}</h1><a class="link" href="#memory">What it remembers →</a></div><p class="lead">How your agent introduces itself, what it is for, and what it may do without asking.</p>
  <form class="section" id="aboutForm"><h3>About</h3><p class="lead">The name people use in the chat and what it is here to do.</p>
    <div class="field"><label>Name</label><input type="text" name="name" value="${esc(agent.name)}" required /></div>
    <div class="field"><label>Purpose</label><textarea name="purpose">${esc(agent.purpose)}</textarea></div>
    <div class="field"><label>Instructions</label><textarea name="instructions" placeholder="Anything it should always keep in mind.">${esc(agent.instructions)}</textarea></div>
    <div class="field"><label>Effort</label><select name="effort">${EFFORTS.map((e) => `<option value="${e}" ${e === agent.effort ? "selected" : ""}>${e}</option>`).join("")}</select><div class="hint">How hard it thinks before acting. Higher is slower and more careful.</div></div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>
  <form class="section" id="trustForm"><h3>Trust</h3><p class="lead">Everything else that spends money or contacts someone asks you first.</p>
    <div class="field"><label>Purchases up to this amount go through without asking (USD)</label><input type="number" name="autoApproveUnderUsd" min="0" step="1" value="${esc(t.autoApproveUnderUsd ?? 0)}" /><div class="hint">0 means it always asks.</div></div>
    <div class="field inline"><label>Pause all spending</label><button class="switch" type="button" role="switch" aria-checked="${t.spendingPaused ? "true" : "false"}" data-name="spendingPaused"></button></div>
    <div class="field"><span class="lab">Allowed without asking</span>${AUTO_ALLOW_TOOLS.map(([k, w]) => `<label class="check"><input type="checkbox" name="autoAllow" value="${k}" ${(t.autoAllow ?? []).includes(k) ? "checked" : ""} /> ${esc(w)}</label>`).join("")}<div class="hint">Only for your own requests. Outside 8am to 8pm it still waits until morning.</div></div>
    <div class="field"><span class="lab">Communities it may post to</span><div class="chips" id="communities">${(t.communityPostingAllowed ?? []).map((c) => `<span class="chip" data-c="${esc(c)}">${esc(c)}<button type="button" aria-label="Remove">×</button></span>`).join("")}</div><div class="addrow"><input type="text" id="newCommunity" placeholder="a subreddit or a Rednote group…" /><button class="btn" type="button" id="addCommunity">Add</button></div><div class="hint">Anywhere else it shows you the exact text and waits for a yes.</div></div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>
  <div class="section"><h3>Deploy</h3><p class="lead">Train it in your private chat first; then let it into the group.</p>
    <div class="deploy"><div class="state">${deployed ? `Deployed<span class="tiny">In your rooms since ${esc(fmtDay(agent.deployedAt))}.</span>` : `Not deployed yet<span class="tiny">Train it in your private chat first: tell it a few things about you and one rule.</span>`}</div>${deployed ? "" : `<button class="btn primary" id="deploy" type="button">Deploy</button>`}</div><div class="actions" style="margin-top:6px"><span class="note" id="deployNote"></span></div></div>
`;

  const saved = (form, msg) => {
    const n = form.querySelector(".note");
    n.classList.remove("bad");
    n.textContent = msg;
    setTimeout(() => {
      if (n.textContent === msg) n.textContent = "";
    }, 3000);
  };
  const failed = (form, e) => {
    const n = form.querySelector(".note");
    n.classList.add("bad");
    n.textContent = e.message;
  };
  const about = $("#aboutForm");
  about.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(about);
    try {
      await api(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { name: fd.get("name"), purpose: fd.get("purpose"), instructions: fd.get("instructions"), effort: fd.get("effort") },
        "PATCH",
      );
      saved(about, "Saved.");
      document.activeElement?.blur();
      load();
    } catch (err) {
      failed(about, err);
    }
  };
  const trust = $("#trustForm");
  trust.querySelector(".switch").onclick = (e) => {
    const b = e.currentTarget;
    b.setAttribute("aria-checked", b.getAttribute("aria-checked") === "true" ? "false" : "true");
  };
  const addCommunity = () => {
    const i = $("#newCommunity");
    const v = i.value.trim();
    if (!v) return;
    $("#communities").insertAdjacentHTML("beforeend", `<span class="chip" data-c="${esc(v)}">${esc(v)}<button type="button" aria-label="Remove">×</button></span>`);
    i.value = "";
  };
  $("#addCommunity").onclick = addCommunity;
  $("#newCommunity").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCommunity();
    }
  };
  $("#communities").onclick = (e) => {
    if (e.target.tagName === "BUTTON") e.target.closest(".chip").remove();
  };
  trust.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(trust);
    const body = {
      trust: {
        autoApproveUnderUsd: Math.max(0, Number(fd.get("autoApproveUnderUsd")) || 0),
        spendingPaused: trust.querySelector(".switch").getAttribute("aria-checked") === "true",
        autoAllow: fd.getAll("autoAllow"),
        communityPostingAllowed: $$("#communities .chip").map((c) => c.dataset.c),
      },
    };
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, body, "PATCH");
      saved(trust, "Saved.");
      document.activeElement?.blur();
      load();
    } catch (err) {
      failed(trust, err);
    }
  };
  const dep = $("#deploy");
  if (dep)
    dep.onclick = async () => {
      dep.disabled = true;
      try {
        await api(`/api/agents/${encodeURIComponent(agent.id)}/deploy`, {});
        load();
      } catch (err) {
        dep.disabled = false;
        const n = $("#deployNote");
        n.classList.add("bad");
        n.textContent = err.message;
      }
    };
}

// ---------- Memory page ----------
async function renderMemory() {
  const el = $("#memory");
  const agent = agentFor(state.room);
  if (!agent) {
    el.innerHTML = `<h1>Memory</h1><div class="empty">No agent yet.</div>`;
    return;
  }
  const [{ memories, consolidatedAt }, profiles] = await Promise.all([
    api(`/api/memory?agentId=${encodeURIComponent(agent.id)}`),
    api(`/api/profiles?agentId=${encodeURIComponent(agent.id)}`).catch(() => []),
  ]);
  const scopeName = (m) => (m.scope === "agent" ? "Everywhere" : m.scope === "room" ? (roomOf(m.scopeId)?.name ?? "A room") : nameOf(m.scopeId));
  const scopeKey = (m) => `${m.scope}:${m.scopeId}`;
  const groups = new Map();
  for (const m of memories) {
    const k = scopeKey(m);
    if (!groups.has(k)) groups.set(k, { name: scopeName(m), scope: m.scope, items: [] });
    groups.get(k).items.push(m);
  }
  const order = (g) => (g.scope === "agent" ? 0 : g.scope === "room" ? 1 : 2);
  const sorted = [...groups.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  el.innerHTML = `<div class="headrow"><h1>What ${esc(agent.name)} remembers</h1><div class="actions" style="margin:0"><span class="note">${consolidatedAt ? `Last tidied ${esc(fmt(Number(consolidatedAt)))}` : ""}</span><button class="btn" id="tidy" type="button">Tidy up now</button></div></div>
    <p class="lead">Each note shows where it applies. Notes marked for one person never surface in a group.</p>
    ${profiles.length ? `<div class="memgroup"><h3>In short <span class="tiny">what it reads first</span></h3>${profiles.map((p) => `<div class="profile"><span class="scope">${esc(p.scope === "agent" ? "Everywhere" : p.scope === "room" ? (roomOf(p.scopeId)?.name ?? "A room") : nameOf(p.scopeId))}</span>${esc(p.text)}<div class="meta">derived ${esc(fmt(p.derivedAt))}</div></div>`).join("")}</div>` : ""}
    ${
      sorted.length
        ? sorted
            .map(
              (g) =>
                `<div class="memgroup"><h3>${esc(g.name)} <span class="tiny">${g.scope === "agent" ? "applies in every room" : g.scope === "room" ? "stays in this room" : "private to this person"}</span></h3>${g.items.map((m) => `<div class="mem"><div><div class="text"><span class="scope">${esc(m.type)}</span>${esc(m.text)}</div><div class="meta">${esc(fmtDay(m.statedAt))}${m.type === "observation" ? " · waiting to be tidied" : ""}</div></div><button class="link" data-forget="${esc(m.id)}" type="button">Forget</button></div>`).join("")}</div>`,
            )
            .join("")
        : `<div class="empty"><strong>Nothing learned yet.</strong>As people talk with ${esc(agent.name)}, it keeps dated notes here. Rules you give it take effect at once; the rest is tidied into facts and preferences.</div>`
    }`;
  $$("#memory [data-forget]").forEach((b) => {
    b.onclick = async () => {
      await api(`/api/memory/${encodeURIComponent(b.dataset.forget)}`, null, "DELETE");
      renderMemory();
    };
  });
  $("#tidy").onclick = async () => {
    const b = $("#tidy");
    b.disabled = true;
    b.textContent = "Tidying…";
    try {
      await api("/api/memory/consolidate", { agentId: agent.id });
    } catch (e) {
      status(e.message);
    }
    renderMemory();
  };
}

// ---------- Live deliveries: NDJSON stream; re-render when something lands ----------
async function watch() {
  for (;;) {
    try {
      const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
      const res = await fetch("/api/deliveries/watch", { headers });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        for (;;) {
          i = buf.indexOf("\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const d = JSON.parse(line);
            if (d.type === "delivery") {
              if (d.roomId === state.room) renderThread();
              renderInbox();
              renderLedger();
            }
          } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}

ensureAuth()
  .then((ok) => {
    if (ok) {
      route();
      load();
      watch(); // only once we can present a token; a signed-out stream would just loop on 401
    }
  })
  .catch((e) => status(`Sign-in failed to load: ${e}`, true));
