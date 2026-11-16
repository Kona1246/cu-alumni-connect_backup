var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
(function() {
  const { $, esc, api, flash, clearMsg, toast, fmtDate, fmtTime, av, telHref, delegate } = CU;
  const S = {
    me: null,
    cfg: {},
    notices: [],
    noticeCats: [],
    filter: "All",
    officials: [],
    ogroups: [],
    campuses: [],
    depts: [],
    dFilter: "All",
    curDept: null,
    fbView: "board",
    fbCats: [],
    socket: null,
    room: "general",
    rooms: [],
    dms: [],
    members: [],
    online: /* @__PURE__ */ new Set(),
    msgs: [],
    typingT: null
  };
  const SEEN_KEY = "cu_seen_notice";
  // "Last notice seen" is kept on the server for signed-in members (so the unread
  // badge is the same on every computer) and in the browser for visitors.
  const seenId = () => {
    let local = 0;
    try {
      local = Number(localStorage.getItem(SEEN_KEY)) || 0;
    } catch (e) {
    }
    return Math.max(local, S.me && S.me.seen_notice || 0);
  };
  const setSeen = (id) => {
    try {
      localStorage.setItem(SEEN_KEY, id);
    } catch (e) {
    }
    if (S.me && (S.me.seen_notice || 0) < id) {
      S.me.seen_notice = id;
      api("/me/seen", { method: "POST", body: { id } }).catch(() => {
      });
    }
  };
  const VIEWS = ["home", "notices", "chat", "feedback", "admin", "depts", "join", "profile"];
  function route() {
    let v = (location.hash || "#home").slice(1);
    if (!VIEWS.includes(v)) v = "home";
    if (v === "profile" && !S.me) v = "join";
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === v));
    ({ notices: showNotices, chat: showChat, feedback: showFeedback, admin: renderOfficials, depts: renderDepts, profile: showProfile }[v] || (() => {
    }))();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  function renderHeader() {
    $("who").innerHTML = S.me ? "".concat(av(S.me.name, S.me.reg_no), '<div><div style="font-weight:600">').concat(esc(S.me.name.split(" ")[0]), '</div><a href="#" data-act="logout" style="font-size:12px">Sign out</a></div>') : "";
    $("joinLink").classList.toggle("hidden", !!S.me);
    $("profileLink").classList.toggle("hidden", !S.me);
    const latest = S.notices.reduce((a, n) => Math.max(a, n.id), 0);
    if (location.hash === "#notices" && latest) setSeen(latest);
    const unseen = S.notices.filter((n) => n.id > seenId()).length;
    $("ndot").hidden = !unseen;
    $("ndot").textContent = unseen;
  }
  function noticeHTML(n) {
    const d = CU.toDate(n.created_at), fresh = (Date.now() - d) / 864e5 < 4;
    return '<div class="card notice '.concat(n.pinned ? "pin" : "", '">\n      <div class="date"><b>').concat(d.getDate(), "</b><span>").concat(d.toLocaleDateString("en-IN", { month: "short" }), " ").concat(d.getFullYear(), '</span></div>\n      <div><div class="nmeta"><span class="tag cat-').concat(esc(n.category), '">').concat(esc(n.category), "</span>").concat(n.pinned ? '<span class="tag" style="background:var(--gold-l);color:#7a5c12">📌 Pinned</span>' : "").concat(fresh ? '<span class="tag new">New</span>' : "", "</div>\n      <h3>").concat(esc(n.title), '</h3><p style="white-space:pre-wrap">').concat(esc(n.body), '</p>\n      <div class="nmeta">Posted by the University · ').concat(fmtDate(n.created_at), "\n        ").concat(n.attachment ? ' · <a class="attach" href="'.concat(n.attachment, '" target="_blank" rel="noopener">📎 ').concat(esc(n.attachment_name || "Attachment"), "</a>") : "", "\n        ").concat(n.link ? ' · <a href="'.concat(esc(n.link), '" target="_blank" rel="noopener">Open link ↗</a>') : "", "</div></div>\n    </div>");
  }
  async function loadNotices() {
    const q = encodeURIComponent($("nsearch").value.trim());
    const cat = S.filter === "All" ? "" : encodeURIComponent(S.filter);
    const r = await api("/notices?q=".concat(q, "&category=").concat(cat));
    S.noticeCats = r.categories;
    return r.notices;
  }
  async function showNotices() {
    const list = await loadNotices();
    $("filters").innerHTML = ["All", ...S.noticeCats].map((c) => '<button class="chip '.concat(S.filter === c ? "on" : "", '" data-act="nfilter" data-c="').concat(esc(c), '">').concat(esc(c), "</button>")).join("");
    $("noticeList").innerHTML = list.length ? list.map(noticeHTML).join("") : '<div class="card empty">No notifications match.</div>';
    renderHeader();
  }
  let nTimer;
  $("nsearch").addEventListener("input", () => {
    clearTimeout(nTimer);
    nTimer = setTimeout(showNotices, 250);
  });
  let verified = false;
  (function years() {
    const y = $("ryear");
    y.innerHTML = '<option value="">Select year</option>';
    for (let i = (/* @__PURE__ */ new Date()).getFullYear(); i >= 1950; i--) y.innerHTML += "<option>".concat(i, "</option>");
  })();
  function resetVerify() {
    verified = false;
    $("rmore").classList.add("hidden");
    $("vbox").style.background = "#f7f4f8";
    $("vtext").textContent = "Enter your name, registration number and year, then verify against University records.";
    clearMsg("rmsg");
  }
  ["rname", "rreg"].forEach((i) => $(i).addEventListener("input", resetVerify));
  $("ryear").addEventListener("change", resetVerify);
  const recordInput = () => ({ name: $("rname").value, reg_no: $("rreg").value.trim(), reg_year: Number($("ryear").value) });
  async function verify() {
    $("vbtn").disabled = true;
    $("vtext").textContent = "Checking University records…";
    try {
      const r = await api("/register/verify", { method: "POST", body: recordInput() });
      verified = true;
      clearMsg("rmsg");
      $("vbox").style.background = "var(--green-l)";
      $("vtext").innerHTML = '<b style="color:var(--green)">✓ Record verified</b> — '.concat(esc(r.name), ", registered ").concat(r.reg_year);
      $("rname").value = r.name;
      $("rsubj").value = r.subject;
      $("rcoll").value = r.college;
      $("rmore").classList.remove("hidden");
      $("remail").focus();
    } catch (e) {
      $("vbox").style.background = "var(--red-l)";
      $("vtext").textContent = "Not verified.";
      flash("rmsg", "err", e.message);
    } finally {
      $("vbtn").disabled = false;
    }
  }
  $("t-r").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!verified) return flash("rmsg", "err", "Please verify your registration first.");
    if ($("rpw").value !== $("rpw2").value) return flash("rmsg", "err", "Passwords don't match.");
    try {
      const r = await api("/register", { method: "POST", body: __spreadProps(__spreadValues({}, recordInput()), { email: $("remail").value.trim(), mobile: $("rmob").value.trim(), org: $("rorg").value.trim(), password: $("rpw").value, agree: $("ragree").checked }) });
      $("t-r").reset();
      resetVerify();
      await signedIn(r.member, "Welcome, ".concat(r.member.name.split(" ")[0], "! Your membership is active."));
    } catch (err) {
      flash("rmsg", "err", err.message);
    }
  });
  $("t-s").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/login", { method: "POST", body: { id: $("sid").value.trim(), password: $("spw").value } });
      $("t-s").reset();
      clearMsg("smsg");
      await signedIn(r.member, "Welcome back, ".concat(r.member.name.split(" ")[0]));
    } catch (err) {
      flash("smsg", "err", err.message);
    }
  });
  async function signedIn(member, msg) {
    S.me = member;
    toast(msg);
    connectSocket();
    renderHeader();
    location.hash = "#chat";
  }
  function tab(t) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    $("t-r").classList.toggle("hidden", t !== "r");
    $("t-s").classList.toggle("hidden", t !== "s");
  }
  function showProfile() {
    const m = S.me;
    $("profSummary").textContent = "".concat(m.name, " · Reg. no. ").concat(m.reg_no, " (").concat(m.reg_year, ") · ").concat(m.subject).concat(m.college ? ", " + m.college : "", " · ").concat(m.email);
    $("pmob").value = m.mobile || "";
    $("porg").value = m.org || "";
    $("pcur").value = "";
    $("pnew").value = "";
  }
  $("profForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/me", { method: "PATCH", body: { mobile: $("pmob").value.trim(), org: $("porg").value.trim(), current_password: $("pcur").value, new_password: $("pnew").value } });
      S.me = r.member;
      showProfile();
      flash("prmsg", "ok", "Profile saved.");
    } catch (err) {
      flash("prmsg", "err", err.message);
    }
  });
  function connectSocket() {
    if (S.socket || typeof io === "undefined") return;
    S.socket = io({ withCredentials: true });
    S.socket.on("connect", () => S.socket.emit("join", S.room, () => {
    }));
    S.socket.on("message", (m) => {
      var _a;
      if (m.room === S.room) {
        S.msgs.push(m);
        renderStream();
        $("typing").textContent = "";
      } else if (m.room.startsWith("dm-") && m.member_id !== ((_a = S.me) == null ? void 0 : _a.id)) {
        toast("New message from ".concat(m.name));
        loadRooms();
      }
    });
    S.socket.on("message:deleted", ({ id, room }) => {
      if (room === S.room) {
        S.msgs = S.msgs.filter((m) => m.id !== id);
        renderStream();
      }
    });
    S.socket.on("typing", ({ room, name }) => {
      if (room !== S.room) return;
      $("typing").textContent = "".concat(name.split(" ")[0], " is typing…");
      clearTimeout(S.typingT);
      S.typingT = setTimeout(() => {
        $("typing").textContent = "";
      }, 2500);
    });
    S.socket.on("presence", (ids) => {
      S.online = new Set(ids);
      renderMembers();
    });
    S.socket.on("notice:new", (n) => {
      toast("New notification: ".concat(n.title));
      refreshNoticeCount();
    });
    S.socket.on("member:joined", () => {
      if (location.hash === "#chat") loadMembers();
    });
    S.socket.on("connect_error", () => {
    });
  }
  async function loadRooms() {
    const r = await api("/chat/rooms");
    S.rooms = r.rooms;
    S.dms = r.dms;
    renderRooms();
  }
  async function loadMembers() {
    S.members = await api("/members");
    renderMembers();
  }
  async function showChat() {
    $("chatGate").classList.toggle("hidden", !!S.me);
    $("chatApp").classList.toggle("hidden", !S.me);
    if (!S.me) return;
    connectSocket();
    await Promise.all([loadRooms(), loadMembers()]);
    await openRoom(S.room);
  }
  function roomInfo() {
    const r = S.rooms.find((x) => x.key === S.room);
    if (r) return { title: "# " + r.name, sub: r.sub };
    const d = S.dms.find((x) => x.key === S.room) || S.pendingDm;
    return d ? { title: d.other.name, sub: "Private conversation · ".concat(d.other.reg_year, " · ").concat(d.other.subject) } : { title: "", sub: "" };
  }
  function renderRooms() {
    $("rooms").innerHTML = S.rooms.map((r) => '<div class="room '.concat(S.room === r.key ? "on" : "", '" data-act="room" data-k="').concat(esc(r.key), '"># ').concat(esc(r.name), "</div>")).join("");
    $("dms").innerHTML = S.dms.length ? S.dms.map((d) => '<div class="room '.concat(S.room === d.key ? "on" : "", '" data-act="room" data-k="').concat(esc(d.key), '">').concat(av(d.other.name, d.other.id, 22), " ").concat(esc(d.other.name), "</div>")).join("") : '<div class="muted" style="font-size:12.5px;padding:4px 10px">Click a member to start a private chat.</div>';
    const info = roomInfo();
    $("roomTitle").textContent = info.title;
    $("roomSub").textContent = info.sub;
  }
  function renderMembers() {
    if (!S.me) return;
    const q = $("msearch").value.trim().toLowerCase();
    const list = S.members.filter((m) => m.id !== S.me.id && (!q || (m.name + m.subject + m.reg_year).toLowerCase().includes(q)));
    $("members").innerHTML = list.map((m) => '<div class="member" data-act="dm" data-id="'.concat(m.id, '" title="Message ').concat(esc(m.name), '">').concat(av(m.name, m.id, 30), '<div style="min-width:0"><div style="font-size:13.5px;font-weight:500">').concat(esc(m.name), "</div><small>").concat(m.reg_year, " · ").concat(esc(m.subject), "</small></div>").concat(S.online.has(m.id) ? '<span class="online" title="Online"></span>' : "", "</div>")).join("") || '<div class="muted" style="font-size:13px;padding:8px">No other members yet.</div>';
  }
  $("msearch").addEventListener("input", renderMembers);
  async function openRoom(key) {
    var _a;
    S.room = key;
    $("typing").textContent = "";
    renderRooms();
    (_a = S.socket) == null ? void 0 : _a.emit("join", key, () => {
    });
    try {
      S.msgs = await api("/chat/history?room=" + encodeURIComponent(key));
    } catch (e) {
      S.msgs = [];
      toast(e.message);
    }
    S.hasMore = S.msgs.length >= 60;
    renderStream(true);
  }
  async function loadOlder() {
    const older = await api("/chat/history?room=".concat(encodeURIComponent(S.room), "&before=").concat(S.msgs[0].id));
    S.hasMore = older.length >= 60;
    S.msgs = older.concat(S.msgs);
    renderStream(false);
  }
  function renderStream(scroll = true) {
    const el = $("stream");
    el.innerHTML = (S.hasMore ? '<button class="btn ghost sm loadmore" data-act="older">Load earlier messages</button>' : "") + (S.msgs.length ? S.msgs.map((m) => {
      const mine = m.member_id === S.me.id;
      return '<div class="m '.concat(mine ? "me" : "", '">').concat(av(m.name, m.member_id), '<div><div class="nm"><b>').concat(mine ? "You" : esc(m.name), "</b> · ").concat(fmtTime(m.created_at), '</div><div class="bub">').concat(esc(m.body), "</div></div></div>");
    }).join("") : '<div class="sys">No messages yet — say hello 👋</div>');
    if (scroll) el.scrollTop = el.scrollHeight;
  }
  $("compose").addEventListener("submit", (e) => {
    var _a;
    e.preventDefault();
    const body = $("cin").value.trim();
    if (!body) return;
    if (!((_a = S.socket) == null ? void 0 : _a.connected)) return toast("Reconnecting to chat… please try again in a moment.");
    S.socket.emit("message", { room: S.room, body }, (r) => {
      if (r == null ? void 0 : r.error) toast(r.error);
    });
    $("cin").value = "";
  });
  let lastTyping = 0;
  $("cin").addEventListener("input", () => {
    var _a;
    if (Date.now() - lastTyping > 2e3) {
      lastTyping = Date.now();
      (_a = S.socket) == null ? void 0 : _a.emit("typing", S.room);
    }
  });
  async function startDm(id) {
    const { key } = await api("/chat/dm/" + id);
    const other = S.members.find((m) => m.id === id);
    if (!S.dms.some((d) => d.key === key)) S.pendingDm = { key, other };
    await openRoom(key);
    $("cin").focus();
  }
  async function showFeedback() {
    $("fbGate").classList.toggle("hidden", !!S.me);
    $("fbApp").classList.toggle("hidden", !S.me);
    if (!S.me) return;
    if (!S.depts.length) await loadDirectory();
    const r = await api("/feedback?view=" + S.fbView);
    if (!$("fcat").options.length) {
      $("fcat").innerHTML = r.categories.map((c) => "<option>".concat(esc(c), "</option>")).join("");
      $("fdept").innerHTML = "<option>University-wide</option>" + S.depts.map((d) => "<option>".concat(esc(d.name), "</option>")).join("");
    }
    $("fbTabs").innerHTML = [["board", "Suggestions board"], ["mine", "My submissions"]].map(([k, l]) => '<button class="chip '.concat(S.fbView === k ? "on" : "", '" data-act="fbview" data-k="').concat(k, '">').concat(l, "</button>")).join("");
    $("fbList").innerHTML = r.feedback.length ? r.feedback.map((f) => '<div class="card fitem">\n      <div class="nmeta"><span class="st st-'.concat(esc(f.status.split(" ")[0]), '">').concat(esc(f.status), '</span><span class="tag">').concat(esc(f.category), '</span><span class="tag">').concat(esc(f.department), "</span></div>\n      <h3>").concat(esc(f.title), "</h3><p>").concat(esc(f.body), '</p>\n      <div class="nmeta" style="justify-content:space-between"><span>').concat(esc(f.member_name), " · batch of ").concat(f.reg_year, " · ").concat(fmtDate(f.created_at)).concat(f.shared ? "" : " · private to the University", "</span>\n      ").concat(f.shared ? '<button class="support '.concat(f.supported ? "on" : "", '" data-act="support" data-id="').concat(f.id, '">👍 ').concat(f.supported ? "Supported" : "Support", " · ").concat(f.supporters, "</button>") : "", "</div>\n      ").concat(f.reply ? '<div class="reply"><b>University response'.concat(f.replied_at ? " (" + fmtDate(f.replied_at) + ")" : "", ":</b> ").concat(esc(f.reply), "</div>") : "", "\n    </div>")).join("") : '<div class="card empty">'.concat(S.fbView === "mine" ? "You haven't submitted any suggestions yet." : "No suggestions yet — be the first.", "</div>");
  }
  $("fbForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/feedback", { method: "POST", body: { category: $("fcat").value, department: $("fdept").value, title: $("ftitle").value, body: $("fbody").value, shared: $("fshare").checked } });
      $("ftitle").value = "";
      $("fbody").value = "";
      flash("fmsg", "ok", "Thank you — your suggestion has been sent to the University authority. Track its status under “My submissions”.");
      S.fbView = "mine";
      showFeedback();
    } catch (err) {
      flash("fmsg", "err", err.message);
    }
  });
  async function loadDirectory() {
    const [o, d] = await Promise.all([api("/directory/officials"), api("/directory/departments")]);
    S.officials = o.officials;
    S.ogroups = o.groups;
    S.campuses = d.campuses;
    S.depts = d.departments;
    $("sDepts").textContent = S.depts.length;
    $("sOfficials").textContent = S.officials.length;
    $("sFaculty").textContent = S.depts.reduce((a, x) => a + x.faculty.length, 0);
  }
  function renderOfficials() {
    const q = $("osearch").value.trim().toLowerCase();
    const html = S.ogroups.map((g) => {
      const list = S.officials.filter((o) => o.grp === g && (!q || (o.name + o.designation + o.office).toLowerCase().includes(q)));
      if (!list.length) return "";
      return '<div class="dgroup"><h3>'.concat(esc(g), '</h3><div class="ofc">').concat(list.map((o) => '<div class="card person">\n        <div class="ds">'.concat(esc(o.designation), '</div><div class="pn">').concat(esc(o.name), "</div>\n        ").concat(o.email ? '<div class="cline"><span>✉️</span><a href="mailto:'.concat(esc(o.email), '">').concat(esc(o.email), "</a></div>") : "", "\n        ").concat(o.mobile ? '<div class="cline"><span>📱</span><a href="'.concat(telHref(o.mobile), '">').concat(esc(o.mobile), "</a></div>") : "", "\n        ").concat(o.office ? '<div class="cline"><span>🏢</span><span>'.concat(esc(o.office), "</span></div>") : "", "\n      </div>")).join(""), "</div></div>");
    }).join("");
    $("officials").innerHTML = html || '<div class="card empty">No contacts listed yet.</div>';
  }
  $("osearch").addEventListener("input", renderOfficials);
  const campusOf = (d) => S.campuses.find((c) => c.id === d.campus_id);
  function renderDepts() {
    const q = $("dsearch").value.trim().toLowerCase();
    const fl = ["All", "Departments", "Centres", ...S.campuses.map((c2) => "c" + c2.id)];
    const label = (f) => f.startsWith("c") && f !== "Centres" ? S.campuses.find((c2) => "c" + c2.id === f).name : f;
    $("dfilters").innerHTML = fl.map((f) => '<button class="chip '.concat(S.dFilter === f ? "on" : "", '" data-act="dfilter" data-f="').concat(esc(f), '">').concat(esc(label(f)), "</button>")).join("");
    const match = (d2) => !q || (d2.name + " " + d2.council + " " + d2.faculty.map((s) => s.name + " " + s.specialization).join(" ")).toLowerCase().includes(q);
    const list = S.depts.filter((d2) => (S.dFilter === "All" || S.dFilter === "Departments" && d2.type === "Department" || S.dFilter === "Centres" && d2.type === "Centre" || "c" + d2.campus_id === S.dFilter) && match(d2));
    if (list.length && !list.some((d2) => d2.id === S.curDept)) S.curDept = list[0].id;
    $("dlist").innerHTML = list.length ? list.map((d2) => {
      var _a;
      return '<div class="ditem '.concat(d2.id === S.curDept ? "on" : "", '" data-act="dept" data-id="').concat(d2.id, '"><div><b>').concat(esc(d2.name), "</b><small>").concat(esc(((_a = campusOf(d2)) == null ? void 0 : _a.name) || ""), " · ").concat(d2.faculty.length, " faculty</small></div>").concat(d2.type === "Centre" ? '<span class="tag">Centre</span>' : "", "</div>");
    }).join("") : '<div class="empty">No departments match.</div>';
    const d = list.find((x) => x.id === S.curDept);
    if (!d) {
      $("ddetail").innerHTML = '<div class="empty">Select a department or centre.</div>';
      return;
    }
    const c = campusOf(d), prefix = d.type === "Department" ? "Department of " : "";
    const addr = c ? "".concat(esc(c.name), ", ").concat(esc(c.address)) : "";
    const staff = q ? [...d.faculty].sort((a, b) => (b.name + b.specialization).toLowerCase().includes(q) - (a.name + a.specialization).toLowerCase().includes(q)) : d.faculty;
    $("ddetail").innerHTML = '<div class="dhead">\n        <div class="nmeta"><span class="tag">'.concat(esc(d.type), "</span>").concat(d.council ? '<span class="tag">Faculty of '.concat(esc(d.council), "</span>") : "", "</div>\n        <h2>").concat(prefix).concat(esc(d.name), "</h2>\n        ").concat(addr ? '<div class="cline"><span>📍</span><span>'.concat(prefix).concat(esc(d.name), ", University of Calcutta, ").concat(addr, "</span></div>") : "", "\n        ").concat(d.email ? '<div class="cline"><span>✉️</span><a href="mailto:'.concat(esc(d.email), '">').concat(esc(d.email), "</a></div>") : "", "\n        ").concat(d.phone ? '<div class="cline"><span>☎️</span><a href="'.concat(telHref(d.phone), '">').concat(esc(d.phone), "</a></div>") : "", '\n      </div>\n      <div style="padding:16px 22px 0"><b style="font-family:Fraunces,serif;font-size:18px">Faculty members</b> <span class="muted" style="font-size:13px">(').concat(d.faculty.length, ')</span></div>\n      <div class="fac">').concat(staff.map((s) => '<div class="fcard">\n        <b>'.concat(esc(s.name), '</b><div class="muted" style="font-size:13px">').concat(esc(s.designation), '</div>\n        <span class="spec">').concat(esc(s.specialization), "</span>\n        ").concat(s.email ? '<div class="cline"><span>✉️</span><a href="mailto:'.concat(esc(s.email), '">').concat(esc(s.email), "</a></div>") : "", "\n        ").concat(s.phone ? '<div class="cline"><span>☎️</span><a href="'.concat(telHref(s.phone), '">').concat(esc(s.phone), "</a></div>") : "", '\n        <div class="cline"><span>📍</span><span>').concat(s.room ? esc(s.room) + ", " : "").concat(prefix).concat(esc(d.name)).concat(c ? ", " + esc(c.address) : "", "</span></div>\n      </div>")).join("") || '<div class="muted">No faculty listed yet.</div>', "</div>");
  }
  $("dsearch").addEventListener("input", renderDepts);
  delegate({
    tab: (el) => tab(el.dataset.t),
    verify: () => verify(),
    logout: async () => {
      var _a;
      await api("/logout", { method: "POST" });
      S.me = null;
      (_a = S.socket) == null ? void 0 : _a.disconnect();
      S.socket = null;
      renderHeader();
      location.hash = "#home";
      toast("Signed out");
    },
    nfilter: (el) => {
      S.filter = el.dataset.c;
      showNotices();
    },
    room: (el) => openRoom(el.dataset.k),
    dm: (el) => startDm(Number(el.dataset.id)).catch((e) => toast(e.message)),
    older: () => loadOlder(),
    fbview: (el) => {
      S.fbView = el.dataset.k;
      showFeedback();
    },
    support: async (el) => {
      try {
        await api("/feedback/".concat(el.dataset.id, "/support"), { method: "POST" });
        showFeedback();
      } catch (e) {
        toast(e.message);
      }
    },
    dfilter: (el) => {
      S.dFilter = el.dataset.f;
      renderDepts();
    },
    dept: (el) => {
      S.curDept = Number(el.dataset.id);
      renderDepts();
      if (innerWidth < 960) $("ddetail").scrollIntoView({ behavior: "smooth" });
    }
  });
  async function refreshNoticeCount() {
    const r = await api("/notices");
    S.notices = r.notices;
    $("sNotices").textContent = S.notices.length;
    $("homeNotices").innerHTML = S.notices.slice(0, 3).map(noticeHTML).join("") || '<div class="card empty">No notifications yet.</div>';
    renderHeader();
  }
  (async function boot() {
    try {
      const [me, cfg] = await Promise.all([api("/me"), api("/config")]);
      S.me = me.member;
      S.cfg = cfg;
      document.querySelectorAll(".regex").forEach((e) => {
        e.textContent = cfg.regNoExample;
      });
      $("rreg").placeholder = cfg.regNoExample;
      await Promise.all([refreshNoticeCount(), loadDirectory()]);
      if (S.me) connectSocket();
    } catch (e) {
      toast("Could not reach the server: " + e.message);
    }
    renderHeader();
    route();
  })();
})();
