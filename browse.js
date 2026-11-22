// Spotify browser panel (Tab in Bandwave / Ctrl+Alt+B): your library + search, Enter plays in the Spotify app.
const $ = (id) => document.getElementById(id);
let items = [], sel = 0, lastQ = "", library = null, timer;
const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z"/></svg>';

function render(list, emptyMsg) {
  items = list; sel = Math.min(sel, Math.max(0, items.length - 1));
  const el = $("list");
  if (!items.length) { el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
  let html = "", section = null;
  items.forEach((it, i) => {
    if (it.section !== section) { section = it.section; html += `<h3>${esc(section || "Results")}</h3>`; }
    html += `<div class="item${i === sel ? " sel" : ""}" role="option" data-i="${i}" style="--i:${Math.min(i, 30)}"><div class="dot">${PLAY}</div><div class="txt"><div class="t">${esc(it.label)}</div>${it.sub ? `<div class="s">${esc(it.sub)}</div>` : ""}</div></div>`;
  });
  el.innerHTML = html;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function loading(msg) { $("status").textContent = msg; $("list").innerHTML = '<div class="shimmer"></div>'.repeat(6); }
function select(i) {
  if (!items.length) return;
  sel = (i + items.length) % items.length;
  document.querySelectorAll(".item").forEach((e) => e.classList.toggle("sel", +e.dataset.i === sel));
  document.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
}
function play(i) {
  const it = items[i]; if (!it) return;
  $("status").textContent = `Playing ${it.label}…`;
  window.bw.browse("play", it.play);
}
function search() {
  const q = $("q").value.trim();
  if (!q) { lastQ = ""; library ? render(library, "Your library is empty.") : (loading("Reading your library…"), window.bw.browse("library")); return; }
  if (q === lastQ) return;
  lastQ = q; sel = 0; loading("Searching Spotify…");
  window.bw.browse("search", q);
}
function open() { $("q").select(); $("q").focus(); if (!$("q").value) search(); }

$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 650); });  // Spotify navigates per search: wait for a pause in typing
addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); window.bw.toggleBrowse(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); select(sel + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); select(sel - 1); }
  else if (e.key === "Enter") {
    e.preventDefault(); clearTimeout(timer);
    const q = $("q").value.trim();
    if (q && q !== lastQ) search(); else play(sel);
  }
});
$("list").addEventListener("click", (e) => { const it = e.target.closest(".item"); if (it) { select(+it.dataset.i); play(sel); } });
window.bw.onBrowse((m) => {
  if (m.kind === "library") { library = m.items; $("status").textContent = ""; if (!$("q").value.trim()) render(library, "Your library is empty."); }
  else if (m.kind === "search" && m.q === lastQ) { $("status").textContent = m.items.length ? `${m.items.length} results` : ""; render(m.items, `Nothing found for “${esc(m.q)}”.`); }
  else if (m.kind === "played") { $("status").textContent = "Playing"; setTimeout(() => window.bw.toggleBrowse(), 500); }
  else if (m.kind === "error") { $("status").textContent = m.msg; }
});
window.bw.onBrowseOpen(open);
open();
