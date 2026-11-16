// Chooses the member portal or the staff console from the address (#staff...) and loads it.
(function () {
  const modeOf = () => (/^#staff/.test(location.hash) ? "staff" : "member");
  const mode = modeOf();
  document.getElementById("appRoot").innerHTML = document.getElementById("tpl-" + mode).innerHTML;
  document.title = mode === "staff" ? "Staff Console — CU Alumni Connect" : "CU Alumni Connect — University of Calcutta Alumni Network";
  if (mode === "staff" && !/^#staff-/.test(location.hash)) history.replaceState(null, "", "#staff-dashboard");
  window.addEventListener("hashchange", () => {
    if (modeOf() !== mode) location.reload();
  });
  const s = document.createElement("script");
  s.src = "/js/" + mode + ".js";
  document.body.appendChild(s);
})();
