// Circle owner app. Plain script, no framework. Every string that lands in HTML goes through esc().
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  people: [],
  watchConnections: 0,
  drawerOpener: null,
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
// A click handler that forgot its catch still tells the person what went wrong.
addEventListener("unhandledrejection", (e) => status(e.reason?.message ?? "Something went wrong.", true));
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
    // Signed out: the landing page, unless they came from its button or an invite link.
    if (!/^#sign(in|up)\/?$/.test(location.hash) && !location.hash.startsWith("#join=")) {
      location.replace("/welcome");
      return false;
    }
    // Sign-in and sign-up both live on this page, in the app's own light look, never on Clerk's hosted portal.
    $("#app").innerHTML = '<div id="signin" style="min-height:100dvh;padding:40px;display:grid;place-items:center"></div>';
    const opts = {
      // Virtual routing: Clerk keeps its steps (password, code) in memory instead of rewriting the hash,
      // which the app's own router would otherwise read as "signed out somewhere else" and bounce to /welcome.
      routing: "virtual",
      signInUrl: `${location.origin}/#signin`,
      signUpUrl: `${location.origin}/#signup`,
      afterSignInUrl: `${location.origin}/`,
      afterSignUpUrl: `${location.origin}/`,
      appearance: { variables: { colorPrimary: "#111", colorText: "#111", colorBackground: "#fff", borderRadius: "12px", fontFamily: "Inter, system-ui, sans-serif" } },
    };
    if (/^#signup\/?$/.test(location.hash)) window.Clerk.mountSignUp(document.getElementById("signin"), opts);
    else window.Clerk.mountSignIn(document.getElementById("signin"), opts);
    addEventListener("hashchange", () => {
      if (/^#sign(in|up)\/?$/.test(location.hash)) location.reload();
    });
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
const myAgents = () => state.agents.filter((a) => a.ownerId === state.me);
/** The agent a new chat or Settings is about: the one in the open chat if it is mine, else my first. */
const myAgent = () => {
  const here = agentFor(state.room);
  return here && here.ownerId === state.me ? here : (myAgents()[0] ?? here);
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
  await Promise.all([renderInbox(), renderThread(), renderLedger(), loadReach()]);
  renderNav();
  if (state.page === "settings") renderSettings();
  if (state.page === "memory") renderMemory();
}

function route() {
  const h = location.hash.replace("#", "");
  if (h.startsWith("join=")) {
    acceptInvite(h.slice(5)).then(load);
    return;
  }
  if (h.startsWith("room=")) {
    state.room = decodeURIComponent(h.slice(5));
    try {
      localStorage.setItem("circle.room", state.room);
    } catch {}
    state.lastMsgCount = -1;
    location.replace("#chat");
    return;
  }
  if (!$("#pageChat")) {
    // Signed out: the page holds only the sign-in form. Reload only to swap sign-in for sign-up; any other hash is Clerk's own.
    if (/^#sign(in|up)\/?$/.test(location.hash)) location.reload();
    return;
  }
  const [page, sub] = h.split("/");
  state.page = page === "settings" || page === "memory" ? page : "chat";
  state.settingsSection = sub;
  $("#pageChat").hidden = state.page !== "chat";
  $("#pageSettings").hidden = state.page !== "settings";
  $("#pageMemory").hidden = state.page !== "memory";
  $$("#pages a").forEach((a) => {
    a.classList.toggle("on", a.dataset.page === state.page);
    if (a.dataset.page === state.page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
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
$("#homeToggle").onclick = () => {
  const open = $("#app").classList.toggle("home-open");
  $("#homeToggle").setAttribute("aria-expanded", open ? "true" : "false");
};
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
  // The Memory tab is the owner's view of everything the assistant holds; members have no such route.
  $('#pages [data-page="memory"]').hidden = !state.agents.some((a) => a.ownerId === state.me);
  $("#rooms").innerHTML = mine.length
    ? mine
        .map((r) => {
          const f = roomFlags(r.id);
          return `<a href="#chat" data-room="${esc(r.id)}" class="${r.id === state.room ? "on" : ""}"><span class="name">${esc(r.name)}</span>${f ? `<span class="dot ${f}"></span>` : `<span class="sub">${r.channel === "imessage" ? "iMessage" : r.kind === "dm" ? "private" : r.members.length}</span>`}</a>`;
        })
        .join("")
    : `<div class="empty">No rooms yet. Make one and add the people in it.</div>`;
  const open = roomOf(state.room);
  if (open && open.kind === "group") renderMembers(open);
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
    : `<div class="empty">${window.__CLERK_PK ? "Nobody yet. Send a chat's invite link and they appear here." : "Nobody yet. Add the people in your circle."}</div>`;
  // Signed-in deployments: people join by invite link; a person added by hand would share no chat and never show.
  $("#newPerson").hidden = !!window.__CLERK_PK;
  $$("#people [data-edit]").forEach((b) => {
    b.onclick = () => personForm(personOf(b.dataset.edit));
  });
}
$("#newRoom").onclick = () => roomForm();

// Who is in the open chat, under the rooms list. The owner edits roles, removes people, adds by name with a
// phone or email (so a text or a sign-in lands on them), or copies the invite link; everyone else just sees the list.
function renderMembers(room) {
  const owner = _roleIn(room.id) === "owner";
  // Roles are derived, not chosen: the owner, and everyone else. A guest is someone who texted from an unknown
  // number and has no seat yet; the owner adding them makes them a member, so the panel never asks.
  const rows = room.members
    .map((m) => {
      const name = esc(m.person?.displayName ?? m.personId);
      const sub = m.role === "owner" ? "owner" : m.role === "guest" ? "not added yet" : "";
      const remove = owner && m.role !== "owner" ? `<button class="link" data-remove="${esc(m.personId)}" type="button" aria-label="Remove">×</button>` : "";
      return `<div class="memrow"><span class="name">${name}</span>${sub ? `<span class="sub">${sub}</span>` : ""}${remove}</div>`;
    })
    .join("");
  $("#rooms").insertAdjacentHTML(
    "beforeend",
    `<div class="members" id="members"><h2>In ${esc(room.name)}${owner ? ` <button class="link" id="renameRoom" type="button">rename</button>` : ""}</h2>${rows}${
      owner
        ? `<form class="addrow wrap" id="addMember"><input type="text" name="displayName" placeholder="Name" required /><input type="text" name="contact" placeholder="phone or email" /><button class="btn small" type="submit">Add</button></form>
      <button class="link invite" type="button" id="inviteLink">+ Invite people to ${esc(room.name)}</button>`
        : ""
    }</div>`,
  );
  const inv = $("#inviteLink");
  if (inv) inv.onclick = () => copyInvite(room.id);
  const rn = $("#renameRoom");
  if (rn)
    rn.onclick = () => {
      const name = window.prompt("Name this chat", room.name);
      if (!name || name.trim() === room.name) return;
      api(`/api/rooms/${encodeURIComponent(room.id)}`, { name: name.trim() }, "PATCH")
        .then(load)
        .catch((e) => status(e.message, true));
    };
  const member = (id) => `/api/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(id)}`;
  $$("#members [data-remove]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(member(b.dataset.remove), undefined, "DELETE");
        load();
      } catch (e) {
        status(e.message, true);
      }
    };
  });
  const form = $("#addMember");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const contact = String(fd.get("contact") ?? "").trim();
      const body = { displayName: fd.get("displayName"), role: "member" };
      if (contact.includes("@")) body.email = contact;
      else if (contact) body.phoneE164 = contact;
      try {
        await api(`/api/rooms/${encodeURIComponent(room.id)}/members`, body);
        load();
      } catch (err) {
        status(err.message, true);
      }
    };
}

// Chat search (after Fo's /search): 300 ms debounce, three characters or more, one row per room with a snippet.
let searchTimer;
$("#search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 300);
};
async function renderSearch() {
  const q = $("#search").value.trim();
  const box = $("#results");
  if (q.length < 3) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const { results } = await api(`/api/search?q=${encodeURIComponent(q)}${state.me ? `&personId=${encodeURIComponent(state.me)}` : ""}`);
  box.hidden = false;
  box.innerHTML = `<h2>Results</h2>${
    results.length
      ? results
          .map(
            (r) =>
              `<a href="#chat" class="hit" data-room="${esc(r.roomId)}"><span class="name">${esc(r.roomName)}</span>${r.snippet ? `<span class="snip">${r.who ? `${esc(r.who)}: ` : ""}${esc(r.snippet)}</span>` : ""}</a>`,
          )
          .join("")
      : `<div class="empty">No chats match ${esc(q)}.</div>`
  }`;
  $$("#results .hit").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      state.room = a.dataset.room;
      state.lastMsgCount = -1;
      $("#search").value = "";
      box.hidden = true;
      if (state.page !== "chat") location.hash = "chat";
      else setPhoneTab("chat");
      load();
    };
  });
}
$("#newPerson").onclick = () => personForm();

/** One field. Members arrive through the invite link, and the assistant learns what the chat is for by reading it. */
function roomForm() {
  const el = $("#roomForm");
  if (el.innerHTML) {
    el.innerHTML = "";
    return;
  }
  const agent = myAgent();
  if (!agent) {
    status("Make an agent first.");
    return;
  }
  const mine = myAgents();
  el.innerHTML = `<form class="form"><h4>New chat</h4>
    <div class="field"><input type="text" name="name" placeholder="What is it for?" required autocomplete="off" maxlength="80" /></div>
    ${mine.length > 1 ? `<div class="field"><label>Who answers</label><select name="agentId">${mine.map((a) => `<option value="${esc(a.id)}" ${a.id === agent.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div>` : ""}
    <div class="chips starters" id="starters"></div>
    <div class="hint">That is all. You get a link to send; people join when they open it, no app needed. ${esc(agent.name)} picks up what the chat is for as you talk.</div>
    <div class="actions"><button class="btn primary" type="submit">Create</button><button class="btn" type="button" data-cancel>Cancel</button><span class="note"></span></div></form>`;
  const form = el.querySelector("form");
  const name = form.querySelector('input[name="name"]');
  form.querySelector("[data-cancel]").onclick = () => (el.innerHTML = "");
  // Starter chips come from what the assistant knows about this person, so a new account sees none.
  api(`/api/rooms/starters?agentId=${encodeURIComponent(agent.id)}${state.me ? `&personId=${encodeURIComponent(state.me)}` : ""}`)
    .then(({ names }) => {
      const box = $("#starters");
      if (!box || !names?.length) return;
      box.innerHTML = names.map((n) => `<button class="chip" type="button" data-starter="${esc(n)}">${esc(n)}</button>`).join("");
      $$("#roomForm [data-starter]").forEach((b) => {
        b.onclick = () => {
          name.value = b.dataset.starter;
          name.focus();
        };
      });
    })
    .catch(() => undefined);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const members = state.me ? [{ personId: state.me, role: "owner", consented: true }] : [];
      const agentId = form.querySelector('select[name="agentId"]')?.value ?? agent.id;
      const room = await api("/api/rooms", { agentId, name: name.value.trim(), kind: "group", members });
      el.innerHTML = "";
      state.room = room.id;
      state.lastMsgCount = -1;
      if (state.page !== "chat") location.hash = "chat";
      else setPhoneTab("chat");
      load();
    } catch (err) {
      form.querySelector(".note").textContent = err.message;
      form.querySelector(".note").classList.add("bad");
    }
  };
  name.focus();
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
  // Browser notification for a card that landed while this tab was in the background (Settings → Notifications).
  if (state.seenNeeds && document.hidden && notifyOn() && Notification.permission === "granted")
    for (const i of inbox.needsYou) if (!state.seenNeeds.has(i.id)) new Notification(`${agent.name} needs you`, { body: i.title, tag: i.id });
  state.seenNeeds = new Set(inbox.needsYou.map((i) => i.id));
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
              `<div class="card" data-item="${esc(i.id)}"><h4>${esc(i.title)}</h4><p>${esc(i.detail)}</p><div class="meta">${esc(roomOf(i.roomId)?.name ?? "")}${i.requesterId ? ` · asked by ${esc(nameOf(i.requesterId))}` : ""} · ${fmt(i.createdAt)}</div><div class="row">${
                i.kind === "connect_account"
                  ? `<a class="btn primary" href="#chat" data-room="${esc(i.roomId)}">Open the chat to sign in</a><button class="btn" data-dismiss type="button">Dismiss</button>`
                  : `${(i.options ?? []).map((o) => `<button class="btn ${o === "Yes" ? "primary" : ""}" data-answer="${esc(o)}" type="button">${esc(o)}</button>`).join("")}<button class="btn" data-custom type="button">Reply…</button><button class="btn" data-dismiss type="button">Dismiss</button>`
              }</div></div>`,
          )
          .join("")
      : `<div class="empty"><strong>Nothing needs you right now.</strong>When ${esc(agent.name)} gets stuck on something only you can answer, it waits here.</div>`;
    const answer = async (id, text) => {
      // The request returns only when the resumed run settles, which can take minutes: show it as sent
      // at once so nobody taps again.
      const row = $(`#inbox .card[data-item="${CSS.escape(id)}"] .row`);
      if (row) row.innerHTML = `<span class="mut">Answered "${esc(text)}". ${esc(agent.name)} is on it.</span>`;
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
    // A sign-in card is answered inside the chat it belongs to.
    $$("#inbox a[data-room]").forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        state.room = a.dataset.room;
        state.lastMsgCount = -1;
        if (state.page !== "chat") location.hash = "chat";
        else setPhoneTab("chat");
        load();
      };
    });
  } else if (state.tab === "radar") {
    const tasks = inbox.tasks ?? [];
    const canStop = (x) => x.requesterId === state.me || agentFor(x.roomId)?.ownerId === state.me;
    const rows = tasks
      .map(
        (t) =>
          `<div class="card"><h4>${esc(t.title)}</h4><p>${esc(t.progress || (t.status === "waiting" ? "Waiting on someone" : "Working on it"))}</p><div class="meta">${esc(roomOf(t.roomId)?.name ?? "")} · in the background · started ${fmt(t.createdAt)}</div><div class="row">${t.runId ? `<button class="link" data-why="${esc(t.runId)}" type="button">Why?</button>` : ""}${canStop(t) ? `<button class="btn small" data-stoptask="${esc(t.id)}" type="button">Stop</button>` : ""}</div></div>`,
      )
      .concat(
        inbox.inFlight
          .filter((r) => !tasks.some((t) => t.runId === r.id))
          .map(
            (r) =>
              `<div class="card ${r.state === "blocked" ? "blocked" : ""}"><h4>${esc(runStateWords(r))}</h4><p>${esc(roomOf(r.roomId)?.name ?? "")} · ${esc(triggerWords(r))} · started ${fmt(r.startedAt)}</p>${r.waitingFor?.title ? `<div class="meta">${esc(r.waitingFor.title)}</div>` : ""}<div class="row"><button class="link" data-why="${esc(r.id)}" type="button">Why?</button>${canStop(r) ? `<button class="btn small" data-stoprun="${esc(r.id)}" type="button">Stop</button>` : ""}</div></div>`,
          ),
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
    $$("#inbox [data-stoprun], #inbox [data-stoptask]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Stop this? Anything already done outside stays done; the chat is told what.")) return;
        try {
          await api(b.dataset.stoprun ? `/api/runs/${encodeURIComponent(b.dataset.stoprun)}/stop` : `/api/tasks/${encodeURIComponent(b.dataset.stoptask)}/stop`, {});
        } catch (e) {
          status(e.message, true);
        }
        load();
      };
    });
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
    const filter = state.activityFilter ?? "all";
    const shown = inbox.activity.filter((r) => filter === "all" || r.status === filter);
    const chips = `<div class="chips filters">${[
      ["all", "All"],
      ["failed", "Didn't finish"],
      ["stopped", "Stopped"],
      ["done", "Done"],
    ]
      .map(([k, w]) => `<button class="chip ${k === filter ? "on" : ""}" type="button" data-filter="${k}">${w}</button>`)
      .join("")}</div>`;
    el.innerHTML = !inbox.activity.length
      ? `<div class="empty"><strong>Nothing finished yet.</strong>What ${esc(agent.name)} gets done shows up here, in its own words.</div>`
      : chips +
        (shown.length
          ? shown
              .map(
                (r) =>
                  `<div class="card"><h4>${esc(r.outcome ?? r.failureReason ?? statusWords(r.status))}</h4><div class="meta">${esc(roomOf(r.roomId)?.name ?? "")} · ${esc(statusWords(r.status))} · ${fmt(r.endedAt ?? r.startedAt)}</div><div class="row"><button class="link" data-why="${esc(r.id)}" type="button">Why?</button></div></div>`,
              )
              .join("")
          : `<div class="empty">Nothing here.</div>`);
    $$("#inbox [data-filter]").forEach((b) => {
      b.onclick = () => {
        state.activityFilter = b.dataset.filter;
        renderInbox();
      };
    });
    $$("#inbox [data-why]").forEach((b) => {
      b.onclick = () => openDrawer(b.dataset.why);
    });
  }
  renderNav();
}
const runStateWords = (r) =>
  r.state === "blocked"
    ? `Blocked: ${r.waitingFor?.kind === "credential_fix" || r.waitingFor?.kind === "connect_account" ? `needs ${firstName(r.waitingFor.assigneeId)} to sign in` : "its question expired"}`
    : r.state === "waiting"
      ? `Waiting on ${r.waitingFor ? firstName(r.waitingFor.assigneeId) : "someone"}`
      : "Working on it";
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
  const roomId = state.room;
  const cs = (await api(`/api/commitments?roomId=${encodeURIComponent(roomId)}`)).sort(
    (a, b) => (a.status === "open" || a.status === "blocked" ? 0 : 1) - (b.status === "open" || b.status === "blocked" ? 0 : 1) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity),
  );
  if (state.room !== roomId) return;
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

// Cards refresh their numbers with the thread.
setInterval(() => {
  docCards.clear();
}, 8000);
async function renderThread() {
  const el = $("#inner");
  const thread = $("#thread");
  const agent = agentFor(state.room);
  const room = roomOf(state.room);
  if (!state.room) {
    el.innerHTML = `<div class="welcome"><h1>${greeting()}.</h1><p>You are not in any room yet. Make one from the Rooms list.</p></div>`;
    return;
  }
  const roomId = state.room;
  const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=100${state.me ? `&personId=${encodeURIComponent(state.me)}` : ""}`);
  if (state.room !== roomId) return; // the person moved on while this loaded; never paint one room under another
  // Timer and answer prompts are the agent's own notes; the Why? drawer shows them, the thread does not.
  const msgs = (data.messages ?? data).filter((m) => m.role !== "system");
  const active = data.activeRun;
  // Nothing is delivered while a run works, so the "working…" line would never show the current step: re-read every few seconds.
  clearTimeout(state.activePoll);
  if (active && active.status === "running") state.activePoll = setTimeout(() => renderThread(), 3000);
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
    el.innerHTML = `<div class="welcome"><h1>${greeting()}${state.me ? `, ${esc(firstName(state.me))}` : ""}.</h1><p>${agent ? `${esc(agent.name)} is in ${esc(room?.name ?? "this room")}. Ask for anything: something to find, book, fix, remind, or sort out.${room?.focus ? ` Priorities here: ${esc(room.focus)}` : ""}` : "No agent in this room yet."}</p>${inviteBox(room)}<div class="slot" id="slot"></div>${picks.length ? `<div class="sugg">${picks.map((p) => `<button type="button" data-prompt="${esc(p[1])}"><span>${esc(p[0])}</span>${esc(p[2] ?? p[1])}</button>`).join("")}</div>` : ""}${all.length > 3 ? `<button class="another" id="another" type="button">Show others</button>` : ""}</div>`;
    $$(".sugg button").forEach((b) => {
      b.onclick = () => send(b.dataset.prompt);
    });
    wireInviteBox(room);
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
  const here = roomOf(state.room);
  $("#text").placeholder = !agent
    ? "Message…"
    : here?.kind === "group" && here.members.length > 1
      ? `Message ${here.name}… say ${agent.name} to get its attention`
      : `Message ${agent.name}…`;
  let html = msgs
    .map((m) => {
      const who = m.role === "assistant" ? (agent?.name ?? "Agent") : m.role === "system" ? `${agent?.name ?? "Agent"} · ${m.source ?? "note"}` : nameOf(m.authorId);
      const cls = m.role === "user" && m.authorId === state.me ? "me" : m.role === "system" ? "system" : m.source === "notice" || m.source === "narration" ? "notice" : "";
      // The server serves the assistant's text without its record footer; steps come from records, never from text.
      let body = m.role === "assistant" ? m.text : esc(m.text);
      // The assistant writes light Markdown; people's own messages stay as typed.
      const rich = m.role === "assistant";
      const att = rich ? { text: m.text, atts: [] } : splitAttachments(m.text);
      body = rich ? md(body) : linkify(esc(att.text));
      const card = m.card ? cardHtml(m.card) : "";
      return `<div class="msg ${cls}" data-id="${esc(m.id)}"><div class="who">${esc(who)} · ${fmt(m.at)}</div>${attachmentsHtml(att.atts)}${att.text || card || rich ? `<div class="body${rich ? " rich" : ""}">${card ? "" : body}${card}${m.steps?.length ? stepsHtml(m.steps, m.runId) : ""}</div>` : ""}</div>`;
    })
    .join("");
  if (active && active.status === "running") {
    const running = active.steps.find((s) => s.status === "running");
    html += `<div class="working" data-id="working"><span class="dot"></span><span class="shimmer">${esc(running ? running.label : `${agent?.name ?? "Agent"} is working…`)}</span><a href="#" class="why" data-why="${esc(active.id)}">Why?</a></div>`;
  } else if (active && active.status === "waiting") {
    html += `<div class="working" data-id="working"><span class="dot hold"></span><span>${esc(agent?.name ?? "Agent")} is waiting on someone.</span><a href="#" class="why" data-why="${esc(active.id)}">Why?</a></div>`;
  }
  patchThread(el, html);
  $$("#inner [data-connect]").forEach((b) => {
    b.onclick = async () => {
      const card = b.closest(".acard");
      card.querySelectorAll("button").forEach((x) => {
        x.disabled = true;
      });
      try {
        await api(`/api/attention/${encodeURIComponent(card.dataset.item)}/resolve`, { personId: state.me, answer: b.dataset.connect === "done" ? "done" : "cancel" });
        state.lastMsgCount = -1;
        // Start over: close this window and ask for a fresh one, for when the live view has timed out.
        if (b.dataset.connect === "retry") send(`sign me in to ${b.dataset.site} again`);
        else load();
      } catch (err) {
        status(err.message, true);
        card.querySelectorAll("button").forEach((x) => {
          x.disabled = false;
        });
      }
    };
  });
  decorateDocLinks();
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

/**
 * Replace only what changed: messages already on screen keep their nodes (a sign-in iframe mid-typing
 * survives a delivery), new ones are appended, and the "working" line at the end is always redrawn.
 * Anything else (an edit, a removal, a different room) falls back to a full repaint.
 */
function patchThread(el, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const next = [...tpl.content.children];
  const have = [...el.children].filter((c) => c.dataset.id && c.dataset.id !== "working");
  const want = next.filter((c) => c.dataset.id !== "working");
  const prefix = have.length && have.length <= want.length && have.every((c, i) => c.dataset.id === want[i].dataset.id);
  if (!prefix) {
    el.replaceChildren(...next);
    return;
  }
  // The sender's optimistic bubble and its "working…" line carry no id; the stored copies replace them.
  for (const c of [...el.children]) if (!c.dataset.id || c.dataset.id === "working") c.remove();
  for (const c of next.slice(have.length)) el.appendChild(c);
}

// A link to something the assistant made becomes a preview card under the message: title, kind, live progress.
const docCards = new Map();
const KIND_WORDS = { document: "Note", dashboard: "Dashboard", hotels: "Hotels", flights: "Flights", image: "Image", audio: "Voice note", file: "File" };
function docCardHtml(a) {
  const isList = a.kind === "document" && a.summary.items > 0;
  const pct = isList ? Math.round((a.summary.done / a.summary.items) * 100) : 0;
  const kind = isList ? "List" : (KIND_WORDS[a.kind] ?? "Page");
  const meta = isList
    ? `${a.summary.done} of ${a.summary.items} done`
    : a.summary.excerpt
      ? esc(a.summary.excerpt)
      : a.summary.sections?.length
        ? esc(a.summary.sections.join(" · "))
        : "";
  const usd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
  const hotels = (a.summary.hotels ?? [])
    .map(
      (h) =>
        `<span class="hotel">${h.photo ? `<img src="${esc(h.photo)}" alt="" loading="lazy" />` : `<i class="nophoto"></i>`}<span class="n">${esc(h.name)}</span><span class="p"><b>${usd(h.oursUsd)}</b> us${h.pubUsd ? ` · ${usd(h.pubUsd)} ${esc(h.seller ?? "public")}` : ""}</span>${h.pubUsd && h.pubUsd > h.oursUsd ? `<span class="save">−${usd(h.pubUsd - h.oursUsd)}</span>` : ""}</span>`,
    )
    .join("");
  const flights = (a.summary.flights ?? [])
    .map(
      (f) =>
        `<span class="hotel flight"><span class="n">${esc(f.name)}</span><span class="p">${f.oursUsd ? `<b>${usd(f.oursUsd)}</b> us` : "not ours"}${f.pubUsd ? ` · ${usd(f.pubUsd)} ${esc(f.seller ?? "public")}` : ""}</span>${f.oursUsd && f.pubUsd && f.pubUsd > f.oursUsd + 1 ? `<span class="save">−${usd(f.pubUsd - f.oursUsd)}</span>` : ""}</span>`,
    )
    .join("");
  return `<a class="doccard ${esc(a.kind)}" href="/d/${esc(a.id)}" target="_blank" rel="noopener">${a.kind === "image" ? `<img class="thumb" src="/d/${esc(a.id)}?raw=1" alt="" />` : ""}<span class="kind">${kind}</span><strong>${esc(a.title)}</strong>${meta ? `<span class="meta">${meta}</span>` : ""}${isList ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ""}${hotels || flights ? `<span class="hotels">${hotels}${flights}</span>` : ""}<span class="open">Open →</span></a>`;
}
async function decorateDocLinks() {
  for (const link of $$("#inner .body a[href*='/d/']")) {
    const id = (link.getAttribute("href").match(/\/d\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!id || link.closest(".body").querySelector(`.doccard[href="/d/${CSS.escape(id)}"]`)) continue;
    link.classList.add("doclink");
    let info = docCards.get(id);
    if (!info) {
      try {
        info = await api(`/api/artifacts/${encodeURIComponent(id)}${state.me ? `?personId=${encodeURIComponent(state.me)}` : ""}`);
        docCards.set(id, info);
      } catch {
        continue;
      }
    }
    const body = link.closest(".body");
    if (body && !body.querySelector(`.doccard[href="/d/${CSS.escape(id)}"]`)) {
      const anchor = body.querySelector(".steps, .footer");
      if (anchor) anchor.insertAdjacentHTML("beforebegin", docCardHtml(info));
      else body.insertAdjacentHTML("beforeend", docCardHtml(info));
    }
  }
}
const linkify = (escaped) => escaped.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
/** Light Markdown for the assistant's replies: bold, italics, code, links, bullets, numbered lists, headings. Escaped first. */
// A ```cards block is a shortlist: the agent gives options as data, the chat shows them as cards.
function cardsHtml(json) {
  let items;
  try {
    items = JSON.parse(json);
  } catch {
    return `<pre>${esc(json)}</pre>`;
  }
  if (!Array.isArray(items)) return "";
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//.test(u) ? u : "");
  return `<div class="cards">${items
    .slice(0, 6)
    .map((c) => {
      const url = safeUrl(c.url);
      const img = safeUrl(c.image);
      const body = `${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : ""}<span class="t"><strong>${esc(c.title ?? "")}</strong>${c.subtitle ? `<span class="sub">${esc(c.subtitle)}</span>` : ""}${c.note ? `<span class="note">${esc(c.note)}</span>` : ""}</span><span class="side">${c.price ? `<b class="price">${esc(c.price)}</b>` : ""}${c.tag ? `<span class="tag">${esc(c.tag)}</span>` : ""}${url ? `<span class="open">Open →</span>` : ""}</span>`;
      return url
        ? `<a class="optcard${c.tag === "pick" ? " pick" : ""}" href="${esc(url)}" target="_blank" rel="noopener">${body}</a>`
        : `<span class="optcard${c.tag === "pick" ? " pick" : ""}">${body}</span>`;
    })
    .join("")}</div>`;
}
function md(text) {
  // Cards are rendered as data; everything around them is ordinary Markdown.
  const parts = text.split(/```cards\s*\n([\s\S]*?)\n\s*```/);
  if (parts.length > 1) return parts.map((p, i) => (i % 2 ? cardsHtml(p) : mdText(p))).join("");
  return mdText(text);
}
function mdText(text) {
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"(]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)"(]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  let table = null; // rows of a pipe table being collected
  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(
      `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
    );
    table = null;
  };
  for (const line of text.split("\n")) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    // A pipe table: header row, a |---| rule, then rows. The rule line is dropped.
    const row = line.trim().startsWith("|")
      ? line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
      : null;
    if (row) {
      flush();
      closeList();
      if (row.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) table = [];
      table.push(row);
      continue;
    }
    closeTable();
    if (h) {
      flush();
      closeList();
      out.push(`<h4>${inline(h[2])}</h4>`);
    } else if (li || ol) {
      flush();
      const kind = li ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        list = kind;
        out.push(`<${kind}>`);
      }
      out.push(`<li>${inline((li ?? ol)[1])}</li>`);
    } else if (!line.trim()) {
      flush();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush();
  closeList();
  closeTable();
  return out.join("");
}

// An embedded sign-in card: a real browser in the chat, for the person it is addressed to.
function cardHtml(c) {
  if (c.kind !== "connect_account") return "";
  const open = c.status === "open";
  const lead = open
    ? "A real browser opens below. Sign in as you normally would, then press Done. The assistant never sees your password, only the signed-in browser."
    : c.status === "done"
      ? "Signed in. The assistant can use this site as you now."
      : "Cancelled. Nothing was connected.";
  return `<div class="acard ${esc(c.status)}" data-item="${esc(c.itemId)}"><h4>Sign in to ${esc(c.site)}</h4><p>${lead}</p>${
    open
      ? `<iframe src="${esc(c.liveViewUrl)}" title="Sign in to ${esc(c.site)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen></iframe><div class="row"><button class="btn primary" data-connect="done" type="button">Done, I'm signed in</button><button class="btn" data-connect="cancel" type="button">Cancel</button><a class="btn" href="${esc(c.liveViewUrl)}" target="_blank" rel="noopener">Open full size ↗</a><button class="btn" data-connect="retry" data-site="${esc(c.site)}" type="button" title="If the window says the connection closed, start a fresh one">Start over</button></div>`
      : ""
  }</div>`;
}

// ---------- Attachments: photos and files go up as artifacts; the message carries their links ----------
const pendingFiles = [];
function renderPending() {
  const box = $("#pending");
  box.hidden = !pendingFiles.length;
  box.innerHTML = pendingFiles
    .map(
      (f, i) =>
        `<span class="pend">${f.type.startsWith("image/") ? `<img src="${URL.createObjectURL(f)}" alt="" />` : ""}<span class="name">${esc(f.name)}</span><button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`,
    )
    .join("");
  $$("#pending [data-rm]").forEach((b) => {
    b.onclick = () => {
      pendingFiles.splice(Number(b.dataset.rm), 1);
      renderPending();
    };
  });
  placeComposer();
}
function addFiles(files) {
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) status(`${f.name} is over 10 MB.`, true);
    else pendingFiles.push(f);
  }
  renderPending();
}
$("#attach").onclick = () => $("#file").click();
$("#file").onchange = () => {
  addFiles($("#file").files);
  $("#file").value = "";
};
$("#text").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) addFiles(files);
});
$("#thread").addEventListener("dragover", (e) => e.preventDefault());
$("#thread").addEventListener("drop", (e) => {
  e.preventDefault();
  addFiles(e.dataTransfer?.files ?? []);
});
async function uploadFile(f, roomId = state.room) {
  const fd = new FormData();
  fd.append("file", f);
  fd.append("roomId", roomId);
  fd.append("agentId", agentFor(roomId)?.id ?? "");
  const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
  const res = await fetch(`/api/files${state.me ? `?personId=${encodeURIComponent(state.me)}` : ""}`, { method: "POST", body: fd, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
  return data;
}

/** An attachment line as send() writes it: "Photo name: <link>" or "File name: <link>". Shown as the thing itself, never as a filename. */
const ATTACH_LINE = /^(Photo|File) (.+?): https?:\/\/\S+\/d\/([A-Za-z0-9_-]+)$/;
function splitAttachments(text) {
  const atts = [];
  const rest = [];
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(ATTACH_LINE);
    if (m) atts.push({ kind: m[1] === "Photo" ? "image" : "file", name: m[2], id: m[3] });
    else rest.push(line);
  }
  return { text: rest.join("\n").trim(), atts };
}
function attachmentsHtml(atts) {
  if (!atts.length) return "";
  return `<div class="atts">${atts
    .map((a) =>
      a.kind === "image"
        ? `<a class="att img" href="/d/${esc(a.id)}" target="_blank" rel="noopener"><img src="/d/${esc(a.id)}?raw=1" alt="${esc(a.name)}" /></a>`
        : `<a class="att file" href="/d/${esc(a.id)}" target="_blank" rel="noopener"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 3h7l4 4v10H5z M12 3v4h4"/></svg><span>${esc(a.name)}</span></a>`,
    )
    .join("")}</div>`;
}

async function send(text) {
  if ((!text && !pendingFiles.length) || !state.room || !state.me) return;
  const roomId = state.room;
  $("#text").value = "";
  status("");
  if (pendingFiles.length) {
    const files = pendingFiles.splice(0);
    renderPending();
    try {
      const lines = [];
      for (const f of files) {
        const { url } = await uploadFile(f, roomId);
        lines.push(`${f.type.startsWith("image/") ? "Photo" : "File"} ${f.name}: ${location.origin}${url}`);
      }
      text = [text, ...lines].filter(Boolean).join("\n");
    } catch (e) {
      status(e.message, true);
      return;
    }
  }
  const inner = $("#inner");
  if ($("#composer").classList.contains("centered")) inner.innerHTML = "";
  // Show the message at once; the run follows.
  inner.insertAdjacentHTML(
    "beforeend",
    `<div class="msg me"><div class="who">${esc(nameOf(state.me))}</div>${attachmentsHtml(splitAttachments(text).atts)}${splitAttachments(text).text ? `<div class="body">${esc(splitAttachments(text).text)}</div>` : ""}</div><div class="working"><span class="dot"></span><span class="shimmer">${esc(agentFor(state.room)?.name ?? "Agent")} is working…</span></div>`,
  );
  dropComposer();
  $("#thread").scrollTop = $("#thread").scrollHeight;
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { personId: state.me, text, dedupKey: `${state.me}:${Date.now()}` });
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
  state.drawerOpener = document.activeElement;
  $("#drawerClose").focus();
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
  state.drawerOpener?.focus?.();
  state.drawerOpener = null;
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
// Sections follow Fo's /user layout (docs/research/wajo-fo-build.md §8): you first, the assistant last.
const SETTINGS_SECTIONS = [
  ["general", "General"],
  ["address", "Address"],
  ["spending", "Spending"],
  ["invites", "Invites"],
  ["connections", "Connections"],
  ["channels", "Channels"],
  ["permissions", "Permissions"],
  ["notifications", "Notifications"],
  ["assistant", "Assistant"],
];
const NOTIFY_KEY = "circle.notify";
const notifyOn = () => {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
};
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
const patchMe = (body) => api(`/api/people/${encodeURIComponent(state.me)}`, body, "PATCH");

/** Every field's label points at its control, and every switch says what it switches, without touching the markup each form writes. */
function labelFields(root) {
  let k = 0;
  for (const field of root.querySelectorAll(".field")) {
    const label = field.querySelector("label");
    const control = field.querySelector("input, select, textarea, button.switch");
    if (!label || !control) continue;
    if (control.classList.contains("switch")) {
      control.setAttribute("aria-label", label.firstChild?.textContent?.trim() || label.textContent.trim());
      continue;
    }
    if (!control.id) control.id = `f_${root.id || "x"}_${k++}`;
    label.htmlFor = control.id;
  }
}

function renderSettings() {
  const el = $("#settings");
  const active = document.activeElement;
  if (el.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return; // do not clobber what the person is typing
  const agent = myAgents().find((a) => a.id === state.settingsAgent) ?? myAgent();
  const me = personOf(state.me);
  const section = SETTINGS_SECTIONS.some(([k]) => k === state.settingsSection) ? state.settingsSection : "general";
  const render = {
    general: settingsGeneral,
    address: settingsAddress,
    spending: settingsSpending,
    invites: settingsInvites,
    connections: settingsConnections,
    channels: settingsChannels,
    permissions: settingsPermissions,
    notifications: settingsNotifications,
    assistant: settingsAssistant,
  }[section];
  el.innerHTML = `<h1>Settings</h1><div class="settings"><nav class="subnav">${SETTINGS_SECTIONS.map(([k, w]) => `<a href="#settings/${k}" class="${k === section ? "on" : ""}">${w}</a>`).join("")}</nav><div class="grow" id="settingsBody"></div></div>`;
  const box = $("#settingsBody");
  if (!me && section !== "assistant") {
    box.innerHTML = `<div class="empty">Pick who you are first.</div>`;
    return;
  }
  if (!agent && (section === "spending" || section === "permissions" || section === "assistant")) {
    box.innerHTML = `<div class="empty">No agent yet.</div>`;
    return;
  }
  if (agent && agent.ownerId !== state.me && (section === "spending" || section === "permissions" || section === "assistant")) {
    box.innerHTML = `<div class="empty">Only ${esc(nameOf(agent.ownerId))} can change this; it is their assistant and their money.</div>`;
    return;
  }
  render(box, agent, me);
  labelFields(box);
}

function settingsGeneral(box, _agent, me) {
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const comfort = [
    ["medium", "Normal"],
    ["low", "One step at a time, in plain words"],
    ["high", "Brief; I know my way around"],
  ];
  box.innerHTML = `<form class="section" id="generalForm"><h3>About you</h3><p class="lead">What the assistant knows about you when it speaks for you, fills in a form, or picks a time.</p>
    <div class="field"><label>Name</label><input type="text" name="displayName" value="${esc(me.displayName)}" required /></div>
    <div class="field"><label>Pronouns</label><input type="text" name="pronouns" maxlength="40" value="${esc(me.pronouns ?? "")}" placeholder="she/her" /><div class="hint">Used when it refers to you, including to other people.</div></div>
    <div class="field"><label>Time zone</label><input type="text" name="timezone" value="${esc(me.timezone ?? "")}" list="tzList" required /><datalist id="tzList">${zones.map((z) => `<option value="${esc(z)}"></option>`).join("")}</datalist><div class="hint">Reminders and "tomorrow morning" are in this zone.</div></div>
    <div class="field"><label>Phone</label><input type="tel" name="phoneE164" value="${esc(me.phoneE164 ?? "")}" placeholder="+1 408 555 0100" /><div class="hint">Texts from this number reach the assistant as you.</div></div>
    <div class="field"><label>Email</label><input type="text" inputmode="email" name="email" value="${esc(me.email ?? "")}" placeholder="you@example.com" /><div class="hint">Mail you send from here reaches the assistant as you.</div></div>
    <div class="field"><label>How it talks to you</label><select name="techComfort">${comfort.map(([v, w]) => `<option value="${v}" ${(me.techComfort ?? "medium") === v ? "selected" : ""}>${w}</option>`).join("")}</select></div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>`;
  const form = $("#generalForm");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await patchMe(Object.fromEntries(["displayName", "pronouns", "timezone", "phoneE164", "email", "techComfort"].map((k) => [k, String(fd.get(k) ?? "").trim()])));
      saved(form, "Saved.");
      document.activeElement?.blur();
      load();
    } catch (err) {
      failed(form, err);
    }
  };
}

function settingsAddress(box, _agent, me) {
  const row = (label, sub, action) => `<div class="connrow"><div><strong>${esc(label)}</strong><div class="tiny">${esc(sub)}</div></div>${action}</div>`;
  box.innerHTML = `<div class="section"><h3>Addresses</h3><p class="lead">Used to fill in checkout and forms when the assistant shops or books for you. It can save one from the chat too.</p>
    ${(me.addresses ?? []).map((a) => row(a.label, `${a.line1}${a.line2 ? `, ${a.line2}` : ""}, ${a.city}${a.region ? ` ${a.region}` : ""} ${a.postalCode ?? ""}`, `<button class="btn small" type="button" data-addr="${esc(a.id)}">Remove</button>`)).join("") || `<div class="tiny">None yet.</div>`}
    <form class="addrow wrap" id="addrForm"><input type="text" name="label" placeholder="Home" required /><input type="text" name="line1" placeholder="Street" required /><input type="text" name="city" placeholder="City" required /><input type="text" name="region" placeholder="State" /><input type="text" name="postalCode" placeholder="Postal code" /><button class="btn small" type="submit">Save address</button></form></div>`;
  $$("#settingsBody [data-addr]").forEach((b) => {
    b.onclick = async () => {
      await patchMe({ addresses: (me.addresses ?? []).filter((a) => a.id !== b.dataset.addr) });
      await load();
      renderSettings();
    };
  });
  const af = $("#addrForm");
  af.onsubmit = async (e) => {
    e.preventDefault();
    const a = Object.fromEntries(new FormData(af).entries());
    await patchMe({ addresses: [...(me.addresses ?? []), { id: `addr_${Date.now().toString(36)}`, country: "US", ...a }] });
    document.activeElement?.blur();
    await load();
    renderSettings();
  };
}

function settingsSpending(box, agent) {
  const t = agent.trust ?? {};
  box.innerHTML = `<form class="section" id="spendForm"><h3>Spending approvals</h3><p class="lead">Purchases you ask for at or under this amount go through without asking. Anyone else's purchase asks you every time.</p>
    <div class="field"><label>Ask before purchases over (USD)</label><input type="number" name="autoApproveUnderUsd" min="0" step="0.01" value="${esc(Number(t.autoApproveUnderUsd ?? 0).toFixed(2))}" /><div class="hint">0 means it asks for every purchase.</div></div>
    <div class="field inline"><label>Pause agent spending<div class="hint">While paused, it won't buy anything, whatever the amount.</div></label><button class="switch" type="button" role="switch" aria-checked="${t.spendingPaused ? "true" : "false"}"></button></div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>
  <div class="section"><h3>How it pays</h3><p class="lead">Each purchase gets a single-use card for exactly that amount at that shop; the card details go to the browser inside the vault and never pass through the chat. The receipt in the chat carries the amount, the shop and the last four digits.</p></div>`;
  const form = $("#spendForm");
  const sw = form.querySelector(".switch");
  sw.onclick = () => sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { trust: { autoApproveUnderUsd: Math.max(0, Number(new FormData(form).get("autoApproveUnderUsd")) || 0), spendingPaused: sw.getAttribute("aria-checked") === "true" } },
        "PATCH",
      );
      saved(form, "Saved.");
      document.activeElement?.blur();
      load();
    } catch (err) {
      failed(form, err);
    }
  };
}

function settingsInvites(box) {
  const rooms = myRooms().filter((r) => r.kind === "group");
  box.innerHTML = `<div class="section"><h3>Invite people</h3><p class="lead">Each chat has its own link. Whoever opens it joins that chat and can ask the assistant there; anything that spends money or uses an account still asks the owner.</p>
    ${rooms.map((r) => `<div class="connrow"><div><strong>${esc(r.name)}</strong><div class="tiny">${r.members.length} ${r.members.length === 1 ? "person" : "people"}</div></div><div class="actions" style="margin:0"><button class="btn small" type="button" data-invite="${esc(r.id)}">Copy invite link</button><span class="note"></span></div></div>`).join("") || `<div class="empty">No group chats yet. Make one from the Rooms list.</div>`}
  </div>`;
  $$("#settingsBody [data-invite]").forEach((b) => {
    b.onclick = () => copyInvite(b.dataset.invite, b.closest(".actions").querySelector(".note"));
  });
}

function settingsConnections(box) {
  box.innerHTML = `<div class="section"><h3>Connections</h3><p class="lead">Your own accounts and the services the assistant may reach for your requests. It sees names only; secrets stay in the vault.</p><div id="connections">Loading…</div></div>`;
  renderConnections();
}

/** Putting the assistant in your own chats: its number, a contact card, your phone linked, a group to add it to. */
async function settingsChannels(box, agent) {
  let info = { channels: [], linked: {}, mine: {} };
  try {
    info = await api(`/api/channels?personId=${encodeURIComponent(state.me)}`);
  } catch {}
  const im = info.channels.find((c) => c.channel === "imessage");
  const name = esc(agent?.name ?? "the assistant");
  if (!im) {
    box.innerHTML = `<div class="section"><h3>Put ${name} in your chats</h3><p class="lead">iMessage is not connected on this server yet. Until it is, ${name} lives here on the web: make a chat and send its invite link.</p></div>`;
    return;
  }
  const linked = info.linked?.phone;
  const mine = info.mine?.phone;
  const contact = (phone) =>
    `<strong>${esc(phone)}</strong> <a class="btn small" href="/api/channels/vcard?personId=${encodeURIComponent(state.me)}">Add to contacts</a> <a class="btn small" href="sms:${esc(phone)}">Text it</a>`;
  if (im.mode === "shared") {
    // The free plan: no number of its own. Each person registers the handle they iMessage from and gets a
    // number from Photon's pool; the assistant texts first so that number lands in their Messages.
    box.innerHTML = `<div class="section"><h3>Text with ${name}</h3><p class="lead">${name} can text with you one-to-one on iMessage. Give it the number you iMessage from and it texts you first; save that number like a friend's and reply there any time.</p>
      ${
        mine
          ? `<p>Your number for ${name}: ${contact(mine)}</p><p class="tiny">It replied to <strong>${esc(linked)}</strong>. Texts from that phone reach ${name} as you.</p>`
          : `<form class="row" id="registerForm"><input type="tel" name="phone" value="${esc(linked ?? "")}" placeholder="+1 408 555 0100" required /><button class="btn primary" type="submit">Text me</button><span class="note"></span></form><div class="hint">The number you iMessage from, with the country code. If ${name}'s text never arrives, your iPhone may start chats from your Apple ID email: Settings → Messages → Send & Receive → Start new conversations from.</div>`
      }
      <div class="hint" style="margin-top:14px"><strong>Group chats</strong> need ${name} to have a number of its own, which Photon sells on its Business plan. Until then, groups live here on the web: make a chat and send its invite link, and ${name} still texts each of you one-to-one.</div></div>`;
    const form = $("#registerForm");
    if (form)
      form.onsubmit = async (e) => {
        e.preventDefault();
        const note = form.querySelector(".note");
        const btn = form.querySelector("button");
        btn.disabled = true;
        note.textContent = "Registering…";
        try {
          const r = await api("/api/channels/register", { personId: state.me, phone: new FormData(form).get("phone") });
          note.textContent = `Sent. Look for a text from ${r.assignedPhone}.`;
          setTimeout(() => renderSettings(), 1500);
        } catch (err) {
          note.textContent = err.message;
          btn.disabled = false;
        }
      };
    return;
  }
  const phone = im.phone;
  box.innerHTML = `<div class="section"><h3>Put ${name} in your chats</h3><p class="lead">${name} has its own phone number. Save it like a friend's, then text it or add it to any group in Messages.</p>
    <ol class="howto">
      <li><strong>Save the number:</strong> ${contact(phone)}</li>
      <li><strong>Link your phone</strong> so ${name} knows texts from it are you: ${linked ? `${esc(linked)} is linked.` : `<button class="btn small primary" type="button" id="linkPhone">Link my phone</button>`}<div id="linkBox"></div></li>
      <li><strong>Add it to a group:</strong> open the group in Messages, tap the names at the top, Add Contact, pick ${name}. It joins like a friend, the group shows up here in Rooms, and you can name it and set what it is for.</li>
    </ol>
    <div class="hint">In a group it answers when named or when a message is clearly for it, and stays quiet otherwise. Anything that spends money or contacts someone still asks you first, in your own thread with it.</div></div>`;
  const btn = $("#linkPhone");
  if (btn)
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api("/api/channels/link-code", { personId: state.me });
        $("#linkBox").innerHTML =
          `<div class="linkcode"><div class="code">${esc(r.code)}</div><p>Text this code to ${esc(r.phone ?? "the number above")} within 15 minutes.${r.sms ? ` On your phone, <a href="${esc(r.sms)}">tap to open Messages with it typed</a>; from a computer, scan it:` : ""}</p>${r.qr ? `<div class="qr">${r.qr}</div>` : ""}<div class="tiny">You get "Linked" back by text; this page shows it when you reopen it.</div></div>`;
      } catch (e) {
        status(e.message, true);
        btn.disabled = false;
      }
    };
}

async function settingsPermissions(box, agent, me) {
  const t = agent.trust ?? {};
  let info = { google: false };
  try {
    info = await api(`/api/connections/info?personId=${encodeURIComponent(state.me)}`);
  } catch {}
  box.innerHTML = `<div class="section"><h3>Send email as you</h3><p class="lead">Let the assistant send from your connected Google account, as you. Each send still needs your go-ahead in the chat. Off until you turn it on; when off it writes from its own address with you in cc.</p>
    <div class="field inline"><label>Send email from my Gmail${info.google ? "" : `<div class="hint">Connect Google first, under Connections.</div>`}</label><button class="switch" id="sendAsMe" type="button" role="switch" aria-checked="${me.sendAsMe ? "true" : "false"}" ${info.google ? "" : "disabled"}></button></div></div>
  <form class="section" id="allowForm"><h3>Allowed without asking</h3><p class="lead">Only for your own requests. Everything else that contacts someone asks you first, and outside 8am to 8pm it waits until morning.</p>
    <div class="field">${AUTO_ALLOW_TOOLS.map(([k, w]) => `<label class="check"><input type="checkbox" name="autoAllow" value="${k}" ${(t.autoAllow ?? []).includes(k) ? "checked" : ""} /> ${esc(w)}</label>`).join("")}</div>
    <div class="field"><span class="lab">Communities it may post to</span><div class="chips" id="communities">${(t.communityPostingAllowed ?? []).map((c) => `<span class="chip" data-c="${esc(c)}">${esc(c)}<button type="button" aria-label="Remove">×</button></span>`).join("")}</div><div class="addrow"><input type="text" id="newCommunity" placeholder="a subreddit or a Rednote group…" /><button class="btn" type="button" id="addCommunity">Add</button></div><div class="hint">Anywhere else it shows you the exact text and waits for a yes.</div></div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>`;
  const sam = $("#sendAsMe");
  sam.onclick = async () => {
    const on = sam.getAttribute("aria-checked") !== "true";
    sam.setAttribute("aria-checked", on ? "true" : "false");
    await patchMe({ sendAsMe: on });
    load();
  };
  const form = $("#allowForm");
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
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { trust: { autoAllow: new FormData(form).getAll("autoAllow"), communityPostingAllowed: $$("#communities .chip").map((c) => c.dataset.c) } },
        "PATCH",
      );
      saved(form, "Saved.");
      document.activeElement?.blur();
      load();
    } catch (err) {
      failed(form, err);
    }
  };
}

function settingsNotifications(box) {
  const supported = "Notification" in window;
  box.innerHTML = `<div class="section"><h3>Browser notifications</h3><p class="lead">Get told when the assistant stops and needs you (a purchase approval, a sign-in, a question) while you are in another tab.</p>
    <div class="field inline"><label>Needs your input${supported ? "" : `<div class="hint">This browser does not support notifications.</div>`}</label><button class="switch" id="notifyToggle" type="button" role="switch" aria-checked="${notifyOn() ? "true" : "false"}" ${supported ? "" : "disabled"}></button></div>
    <div class="hint" id="notifyNote">${supported && Notification.permission === "denied" ? "Notifications are blocked for this site in your browser settings." : ""}</div></div>`;
  const sw = $("#notifyToggle");
  sw.onclick = async () => {
    const on = sw.getAttribute("aria-checked") !== "true";
    if (on && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
      $("#notifyNote").textContent = "Notifications are blocked for this site in your browser settings.";
      return;
    }
    sw.setAttribute("aria-checked", on ? "true" : "false");
    try {
      localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
    } catch {}
  };
}

function settingsAssistant(box, agent) {
  const mine = myAgents();
  const rooms = state.rooms.filter((r) => r.agentId === agent.id && r.kind === "group");
  const pinned = agent.modelPinned ? agent.model : "";
  box.innerHTML = `<div class="section" id="agentsBox"><h3>Your assistants</h3><p class="lead">Each one has its own name, memory, chats and limits. The one picked here is the one the rest of this page changes.</p>
    <div class="chips">${mine.map((a) => `<button class="chip ${a.id === agent.id ? "on" : ""}" type="button" data-agent="${esc(a.id)}">${esc(a.name)}</button>`).join("")}<button class="chip" type="button" id="newAgentBtn">+ New assistant</button></div>
    <form class="form" id="newAgentForm" hidden><div class="field"><label>Name</label><input type="text" name="name" required maxlength="60" /></div>
      <div class="field"><label>What it is for (optional)</label><textarea name="purpose"></textarea></div>
      <div class="actions"><button class="btn primary" type="submit">Create</button><button class="btn" type="button" data-cancel>Cancel</button><span class="note"></span></div></form>
    <div id="lineBox"></div></div>
  <div class="section" id="pauseBox"><h3>${agent.paused ? `${esc(agent.name)} is paused` : "Off switch"}</h3><p class="lead">${
    agent.paused
      ? "It reads messages but does nothing: no replies, no reminders, no background work. Reminders that come due wait until it is back on."
      : "Stops everything it is doing now and anything new, until you turn it back on. Each chat it stops in is told what had already been done."
  }</p><div class="actions"><button class="btn ${agent.paused ? "primary" : ""}" type="button" id="pauseBtn">${agent.paused ? "Turn back on" : `Pause ${esc(agent.name)}`}</button><span class="note"></span></div></div>
  <form class="section" id="aboutForm"><h3>About ${esc(agent.name)}</h3><p class="lead">The name people use in the chat. It is a general assistant; narrow it here only if you want to. <a class="link" href="#memory">What it remembers →</a></p>
    <div class="field"><label>Name</label><input type="text" name="name" value="${esc(agent.name)}" required /></div>
    <div class="field"><label>What it is for (optional)</label><textarea name="purpose">${esc(agent.purpose)}</textarea><div class="hint">Leave the default to keep it general. Priorities for a particular chat are set below.</div></div>
    <div class="field"><label>Instructions</label><textarea name="instructions" placeholder="Anything it should always keep in mind.">${esc(agent.instructions)}</textarea></div>
    <div class="field"><label>Effort</label><select name="effort">${EFFORTS.map((e) => `<option value="${e}" ${e === agent.effort ? "selected" : ""}>${e}</option>`).join("")}</select><div class="hint">How hard it thinks before acting. Higher is slower and more careful.</div></div>
    <div class="field"><label>Model (optional)</label><input type="text" name="model" value="${esc(pinned)}" placeholder="${esc(agent.model ?? "")}" /><div class="hint">Leave empty to use the server's default${agent.model && !pinned ? ` (now ${esc(agent.model)})` : ""}. A model named here is kept across restarts.</div></div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>
  <form class="section" id="limitsForm"><h3>What it may use</h3><p class="lead">Everything is on unless you narrow it. Planning, asking people, reminders, memory and staying quiet are always on.</p><div id="limitsBody" class="tiny">Loading…</div>
    <div class="actions"><button class="btn primary" type="submit">Save</button><span class="note"></span></div></form>
  <div class="section" id="whereForm"><h3>Where it is</h3><p class="lead">Every chat it has been added to, and what that chat mostly needs from it. It stays a general assistant everywhere.</p>
    ${
      rooms
        .map(
          (
            r,
          ) => `<form class="whereroom" data-room="${esc(r.id)}"><div class="headrow"><strong>${esc(r.name)}</strong><span class="mut">${r.members.length} ${r.members.length === 1 ? "person" : "people"}</span></div><div class="field"><label>Priorities here</label><textarea name="focus" placeholder="What this chat mostly needs from it.">${esc(r.focus ?? "")}</textarea></div>
      ${mine.length > 1 ? `<div class="field"><label>Who answers here</label><select name="agentId">${mine.map((a) => `<option value="${esc(a.id)}" ${a.id === agent.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select><div class="hint">Handing the chat over keeps its messages; what ${esc(agent.name)} noted about it stays with ${esc(agent.name)}.</div></div>` : ""}
      <div class="actions"><button class="btn" type="submit">Save</button><span class="note"></span></div></form>`,
        )
        .join("") || `<div class="empty">Not in any group chat yet. Make one from the Rooms list, then share its invite link under Invites.</div>`
    }
  </div>`;
  $$("#agentsBox [data-agent]").forEach((b) => {
    b.onclick = () => {
      state.settingsAgent = b.dataset.agent;
      renderSettings();
    };
  });
  const newForm = $("#newAgentForm");
  $("#newAgentBtn").onclick = () => {
    newForm.hidden = false;
    newForm.querySelector("input").focus();
  };
  newForm.querySelector("[data-cancel]").onclick = () => (newForm.hidden = true);
  newForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(newForm);
    try {
      const a = await api("/api/agents", { ownerId: state.me, name: String(fd.get("name")).trim(), purpose: String(fd.get("purpose") ?? "").trim() });
      state.settingsAgent = a.id;
      document.activeElement?.blur();
      await load();
      renderSettings();
    } catch (err) {
      failed(newForm, err);
    }
  };
  $("#pauseBtn").onclick = async () => {
    if (!agent.paused && !confirm(`Pause ${agent.name}? Anything it is in the middle of stops now.`)) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, { paused: !agent.paused }, "PATCH");
      await load();
      renderSettings();
    } catch (err) {
      failed($("#pauseBox"), err);
    }
  };
  assistantLine(agent, mine);
  assistantLimits(agent);
  $$("#whereForm form.whereroom").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = { focus: fd.get("focus") };
      if (fd.get("agentId") && fd.get("agentId") !== agent.id) body.agentId = fd.get("agentId");
      try {
        await api(`/api/rooms/${encodeURIComponent(form.dataset.room)}`, body, "PATCH");
        saved(form, body.agentId ? "Handed over" : "Saved");
        document.activeElement?.blur();
        load();
      } catch (err) {
        failed(form, err);
      }
    };
  });
  const about = $("#aboutForm");
  about.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(about);
    try {
      await api(
        `/api/agents/${encodeURIComponent(agent.id)}`,
        { name: fd.get("name"), purpose: fd.get("purpose"), instructions: fd.get("instructions"), effort: fd.get("effort"), model: String(fd.get("model") ?? "").trim() },
        "PATCH",
      );
      saved(about, "Saved.");
      document.activeElement?.blur();
      load();
    } catch (err) {
      failed(about, err);
    }
  };
}

/** Which of my assistants answers the iMessage line. Only shown when the line is connected. */
async function assistantLine(_agent, mine) {
  const box = $("#lineBox");
  let info;
  try {
    info = await api(`/api/channels?personId=${encodeURIComponent(state.me)}`);
  } catch {
    return;
  }
  const im = info.channels.find((c) => c.channel === "imessage");
  if (!im || !box) return;
  const current = mine.find((a) => a.id === im.agentId);
  box.innerHTML = `<form class="field" id="lineForm"><label>Answers on iMessage</label><div class="addrow"><select name="agentId">${mine.map((a) => `<option value="${esc(a.id)}" ${a.id === (current?.id ?? "") ? "selected" : ""}>${esc(a.name)}</option>`).join("")}${current ? "" : `<option value="" selected disabled>${im.agentId ? "someone else's assistant" : "nobody picked"}</option>`}</select><button class="btn small" type="submit">Save</button></div><div class="hint">Groups that add the line get this assistant. Chats already running keep theirs; hand them over below.</div><span class="note"></span></form>`;
  const form = $("#lineForm");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const agentId = new FormData(form).get("agentId");
    if (!agentId) return;
    try {
      await api("/api/channels/imessage/agent", { agentId }, "PUT");
      saved(form, "Saved.");
    } catch (err) {
      failed(form, err);
    }
  };
}

/** Skills by name, tools by family; every box ticked means no list at all, so new ones arrive switched on. */
async function assistantLimits(agent) {
  const body = $("#limitsBody");
  let opts;
  try {
    opts = await api("/api/agents/options");
  } catch (err) {
    if (body) body.textContent = err.message;
    return;
  }
  if (!body) return;
  const on = (list, name) => !list || list.includes(name);
  body.className = "";
  body.innerHTML = `<div class="checks"><h4 class="tiny">Tools</h4>${opts.families.map((f) => `<label class="check"><input type="checkbox" name="tools" value="${esc(f)}" ${on(agent.tools, f) ? "checked" : ""} /> ${esc(f)}</label>`).join("")}</div>
    <div class="checks"><h4 class="tiny">Skills</h4>${opts.skills.map((k) => `<label class="check" title="${esc(k.when)}"><input type="checkbox" name="skills" value="${esc(k.name)}" ${on(agent.skills, k.name) ? "checked" : ""} /> ${esc(k.name)}</label>`).join("")}</div>`;
  labelFields(body);
  const form = $("#limitsForm");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const pick = (name, all) => {
      const chosen = fd.getAll(name).map(String);
      return chosen.length === all.length ? null : chosen;
    };
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, { tools: pick("tools", opts.families), skills: pick("skills", opts.skills) }, "PATCH");
      saved(form, "Saved.");
      load();
    } catch (err) {
      failed(form, err);
    }
  };
}

// ---------- Connections (Google, Slack, MCP servers, APIs, the assistant's email) ----------
async function renderConnections() {
  const box = $("#connections");
  if (!box || !state.me) return;
  let info;
  try {
    info = await api(`/api/connections/info?personId=${encodeURIComponent(state.me)}`);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const row = (label, sub, action) => `<div class="connrow"><div><strong>${esc(label)}</strong><div class="tiny">${esc(sub)}</div></div>${action}</div>`;
  box.innerHTML = `
    ${row("Assistant's email", info.agentEmail, `<span class="mut">it sends from here</span>`)}
    ${row("Google", info.google ? "Connected: Gmail, Calendar, Drive, Sheets, Forms, Slides" : info.googleConfigured ? "Not connected" : "Not set up on this server (GOOGLE_CLIENT_ID)", info.google ? `<button class="btn small" type="button" data-disconnect="google">Disconnect</button>` : info.googleConfigured ? `<button class="btn small primary" type="button" id="connectGoogle">Connect</button>` : "")}
    ${row("Slack", info.slack ? "Token saved" : "Not connected", info.slack ? `<button class="btn small" type="button" data-disconnect="slack">Disconnect</button>` : `<form class="addrow" data-kind="slack"><input type="password" name="token" placeholder="xoxb-… or xoxp-…" /><button class="btn small" type="submit">Save</button></form>`)}
    <h4 class="tiny" style="margin:14px 0 4px">MCP servers</h4>
    ${info.mcp.map((n) => row(n, "MCP", `<button class="btn small" type="button" data-disconnect="mcp:${esc(n)}">Remove</button>`)).join("") || `<div class="tiny">None yet. Any app with an MCP endpoint: paste its URL (and a token if it needs one).</div>`}
    <form class="addrow wrap" data-kind="mcp"><input type="text" name="name" placeholder="name, e.g. notion" required /><input type="url" name="url" placeholder="https://…/mcp" /><input type="password" name="token" placeholder="token (optional)" /><button class="btn small" type="submit">Add MCP</button></form>
    <h4 class="tiny" style="margin:14px 0 4px">APIs</h4>
    ${info.apis.map((n) => row(n, "HTTP API", `<button class="btn small" type="button" data-disconnect="api:${esc(n)}">Remove</button>`)).join("") || `<div class="tiny">None yet. A base URL, an OpenAPI document if there is one, and a token.</div>`}
    <form class="addrow wrap" data-kind="api"><input type="text" name="name" placeholder="name, e.g. luma" required /><input type="url" name="baseUrl" placeholder="https://api.example.com" required /><input type="url" name="openapiUrl" placeholder="OpenAPI JSON URL (optional)" /><input type="password" name="token" placeholder="token (optional)" /><button class="btn small" type="submit">Add API</button></form>
    <h4 class="tiny" style="margin:14px 0 4px">Site logins</h4>
    <div class="tiny">${info.sites.length ? `Signed in to: ${info.sites.map(esc).join(", ")}. ` : ""}Sign in to a site inside the chat when the assistant asks (connect_account); passwords never pass through here.</div>`;
  const g = $("#connectGoogle");
  if (g)
    g.onclick = async () => {
      try {
        const r = await api(`/api/connections/google/link?personId=${encodeURIComponent(state.me)}`);
        location.href = r.url;
      } catch (e) {
        status(e.message, true);
      }
    };
  $$("#connections [data-disconnect]").forEach((b) => {
    b.onclick = async () => {
      await api(`/api/people/${encodeURIComponent(state.me)}/connections/${encodeURIComponent(b.dataset.disconnect)}`, undefined, "DELETE");
      renderConnections();
    };
  });
  $$("#connections form[data-kind]").forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f).entries());
      try {
        await api(`/api/people/${encodeURIComponent(state.me)}/connections`, { kind: f.dataset.kind, ...body });
        renderConnections();
      } catch (err) {
        status(err.message, true);
      }
    };
  });
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
      // Anything delivered while the stream was down was missed: refresh on every reconnect.
      if (state.watchConnections++) load().catch(() => {});
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
            if (d.boot) {
              // The server restarted since this page loaded: get the current page, scripts and styles.
              if (state.boot && state.boot !== d.boot) location.reload();
              state.boot = d.boot;
            }
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

// An invite link (#join=token): join the room as the signed-in person, or, without sign-in, by name.
async function acceptInvite(token) {
  try {
    const info = await api(`/api/invites/${encodeURIComponent(token)}`);
    const body = {};
    if (!window.__CLERK_PK) {
      // Local dev: you are whoever the "You" picker says; with nobody picked, give a name.
      if (state.me) body.personId = state.me;
      else {
        const name = window.prompt(`Join "${info.roomName}" with ${info.agentName}. Your name?`);
        if (!name) return;
        body.displayName = name;
        body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
    }
    const r = await api(`/api/invites/${encodeURIComponent(token)}/accept`, body);
    state.me = r.personId;
    state.room = r.room.id;
    try {
      localStorage.setItem("circle.me", state.me);
      localStorage.setItem("circle.room", state.room);
    } catch {}
    status(`You're in ${r.room.name}.`);
  } catch (e) {
    status(e.message, true);
  }
  location.hash = "chat";
}
// How to reach the assistant, the way Fo shows it: its email and number sit in the header all the time.
async function loadReach() {
  if (!state.me) return;
  try {
    const [ch, info] = await Promise.all([api(`/api/channels?personId=${encodeURIComponent(state.me)}`), api(`/api/connections/info?personId=${encodeURIComponent(state.me)}`)]);
    state.reach = { phone: ch.channels.find((c) => c.phone)?.phone ?? null, linkedPhone: ch.linked?.phone ?? null, email: info.agentEmail ?? null, google: !!info.google };
  } catch {
    state.reach = state.reach ?? {};
  }
  const r = state.reach;
  $("#start").innerHTML = gettingStarted();
  $("#reach").innerHTML = [r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "", r.phone ? `<a href="sms:${esc(r.phone)}">${esc(r.phone)}</a>` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The owner's first steps, as Fo lists them: each line is done or a link to where it is done. */
function gettingStarted() {
  const agent = agentFor(state.room) ?? state.agents[0];
  if (!agent || state.me !== agent.ownerId) return "";
  const r = state.reach ?? {};
  const groups = state.rooms.filter((x) => x.kind === "group");
  const items = [
    [`Say hi to ${agent.name}`, state.rooms.some((x) => x.kind === "dm" && (x.lastActivityAt ?? 0) > (x.createdAt ?? 0)), "#chat"],
    ["Link your phone, so texts from it are you", !!r.linkedPhone, "#settings/channels"],
    ["Connect Google for mail and calendar", !!r.google, "#settings/connections"],
    [`Add ${agent.name} to a group chat`, groups.some((x) => x.channel !== "web" || x.members.length > 1), "#settings/channels"],
    ["Invite a friend to a chat", groups.some((x) => x.members.length > 1), "#settings/invites"],
  ];
  if (items.every((i) => i[1])) return "";
  return `<div class="gettingstarted"><strong>Getting started</strong><span class="tiny">Optional, in any order.</span>${items.map(([text, done, href]) => `<a class="${done ? "done" : ""}" href="${href}"><span class="mark">${done ? "✓" : "○"}</span>${esc(text)}</a>`).join("")}</div>`;
}

/** A group chat with nobody else in it yet: the next step is the link, not a form. */
function inviteBox(room) {
  if (room?.kind !== "group" || room.members.length > 1) return "";
  const others = window.__CLERK_PK ? [] : state.people.filter((p) => !room.members.some((m) => m.personId === p.id));
  return `<div class="invitebox"><strong>Just you here so far.</strong>Send the link to the others; they join when they open it, no app needed.<div class="row"><button class="btn primary" type="button" id="inviteCopy">Copy invite link</button>${navigator.share ? `<button class="btn" type="button" id="inviteShare">Share…</button>` : ""}<span class="note"></span></div>${
    others.length
      ? `<div class="row"><span class="note">Or add someone already here:</span>${others.map((p) => `<button class="btn small" type="button" data-addmember="${esc(p.id)}">${esc(p.displayName)}</button>`).join("")}</div>`
      : ""
  }</div>`;
}
function wireInviteBox(room) {
  const copy = $("#inviteCopy");
  if (!copy) return;
  copy.onclick = () => copyInvite(room.id, copy.parentElement.querySelector(".note"));
  const share = $("#inviteShare");
  if (share)
    share.onclick = async () => {
      try {
        const r = await api(`/api/rooms/${encodeURIComponent(room.id)}/invites`, { personId: state.me });
        await navigator.share({ title: room.name, text: `Join "${room.name}"`, url: r.url });
      } catch (e) {
        if (e.name !== "AbortError") status(e.message, true);
      }
    };
  $$("[data-addmember]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${encodeURIComponent(room.id)}/members`, { personId: b.dataset.addmember, role: "member" });
        load();
      } catch (e) {
        status(e.message, true);
      }
    };
  });
}
async function copyInvite(roomId, note) {
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/invites`, { personId: state.me });
    await navigator.clipboard.writeText(r.url);
    if (note) note.textContent = "Invite link copied.";
    else status("Invite link copied.");
  } catch (e) {
    if (note) note.textContent = e.message;
    else status(e.message, true);
  }
}

ensureAuth()
  .then(async (ok) => {
    if (ok) {
      if (location.hash.startsWith("#join=")) await acceptInvite(location.hash.slice(6));
      route();
      load();
      watch(); // only once we can present a token; a signed-out stream would just loop on 401
    }
  })
  .catch((e) => status(`Sign-in failed to load: ${e}`, true));
