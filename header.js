// =====================================================================================
// Collapsible header (immersive look inside an exb Embed widget). Same behaviour as the
// NHY / EFY / GPM apps, adapted to the scorebug header.
//   • "Hide header" button in the scorebug; a small tab at the top-centre brings it back.
//   • Keyboard: H toggles the header (ignored while typing).
//   • Starting state, in priority order:
//       1. URL parameter  ?header=hide  or  ?header=show
//       2. the viewer's last choice (remembered per app in this browser)
//       3. hidden when the app is embedded in a frame, shown when opened directly
// =====================================================================================
const KEY = "app-header-hidden:" + location.pathname;
const IN_FRAME = (() => { try { return window.self !== window.top; } catch { return true; } })();

function initialState() {
  const p = (new URLSearchParams(location.search).get("header") || "").toLowerCase();
  if (["hide", "hidden", "off", "0", "false", "collapsed"].includes(p)) return true;
  if (["show", "on", "1", "true"].includes(p)) return false;
  try {
    const s = localStorage.getItem(KEY);
    if (s !== null) return s === "1";
  } catch { /* storage blocked: fall through */ }
  return IN_FRAME;
}

function setup() {
  const btn = document.getElementById("hideHeaderBtn");
  const tab = document.getElementById("headerTab");
  if (!btn || !tab) return;
  let hidden = initialState();
  const apply = (h, remember) => {
    hidden = h;
    document.body.classList.toggle("header-hidden", h);
    if (remember) { try { localStorage.setItem(KEY, h ? "1" : "0"); } catch { /* ignore */ } }
  };
  apply(hidden, false);
  btn.addEventListener("click", () => apply(true, true));
  tab.addEventListener("click", () => apply(false, true));
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, calcite-input-text, calcite-input, [contenteditable]")) return;
    if (e.key === "h" || e.key === "H") apply(!hidden, true);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
else setup();
