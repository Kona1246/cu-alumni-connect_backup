(function() {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s != null ? s : "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  async function api(path, { method = "GET", body, form } = {}) {
    const opt = { method, credentials: "same-origin", headers: {} };
    if (form) opt.body = form;
    else if (body !== void 0) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const res = await fetch("/api" + path, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || "Request failed (".concat(res.status, ")"));
      e.status = res.status;
      throw e;
    }
    return data;
  }
  function flash(id, type, text) {
    const e = $(id);
    if (!e) return;
    e.className = "msg " + type;
    e.textContent = text;
  }
  const clearMsg = (id) => {
    const e = $(id);
    if (e) e.className = "msg";
  };
  function toast(t) {
    const e = $("toast");
    e.textContent = t;
    e.classList.add("on");
    clearTimeout(toast.h);
    toast.h = setTimeout(() => e.classList.remove("on"), 2600);
  }
  const toDate = (s) => new Date(String(s).includes("T") ? s : String(s).replace(" ", "T") + "Z");
  const fmtDate = (s) => toDate(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const fmtTime = (s) => {
    const d = toDate(s), now = /* @__PURE__ */ new Date();
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  };
  const COLORS = ["#7a1f2b", "#2f5d8a", "#1f7a4d", "#8a5a12", "#5b2ea6", "#9c3d6b", "#3d6b6b"];
  const initials = (n) => String(n).replace(/^(Prof\.|Dr\.|Shri|Smt\.)\s*/, "").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const av = (name, key, size = 32) => '<div class="av" style="background:'.concat(COLORS[String(key).split("").reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length], ";width:").concat(size, "px;height:").concat(size, 'px">').concat(esc(initials(name)), "</div>");
  const telHref = (s) => "tel:" + String(s).replace(/[^\d+]/g, "");
  function confirmClick(btn) {
    if (btn.dataset.armed) return true;
    const label = btn.textContent;
    btn.dataset.armed = 1;
    btn.textContent = "Confirm?";
    setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = label;
    }, 2500);
    return false;
  }
  function delegate(actions) {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (el && actions[el.dataset.act]) {
        e.preventDefault();
        actions[el.dataset.act](el, e);
      }
    });
  }
  window.CU = { $, esc, api, flash, clearMsg, toast, toDate, fmtDate, fmtTime, av, telHref, confirmClick, delegate };
})();
