// =====================================================================================
// Gillette Stadium · Game-Day Ops (v1)
// ArcGIS Maps SDK for JavaScript 5.1 (CDN) + Calcite. Static files, no build step.
// Same sign-in / layer-finding / floor / popup patterns as the NHY, EFY and GPM apps;
// different UX: broadcast scorebug, slide-in stat board, game-day wire ticker.
// All DEMO_* values and the VIP cart simulation are synthetic.
// =====================================================================================
import { classify, setFloor, currentLevel, anchor, tone, esc, LEVELS } from "./layers.js";

const CONFIG = {
  portalUrl: "https://esri-cgs.maps.arcgis.com",
  appId: "dB7jc2tJORyj075F",                      // OAuth 2.0 client ID (same app item as the GPM / NHY / EFY apps)
  webmapId: "80ddaf88579740f4bb244d6999848c7c",   // Gillette Stadium
  websceneId: "a1fb7cac193149c8a0ab9999e7b6ed36",   // Gillette Stadium 3D
  fieldZ: 79.3,                                   // field / Event Level floor, NAVD88 m (the Indoors data's Z)                                 // Gillette Stadium 3D web scene item ID (or open the app with ?scene=<item id>)
  refreshSeconds: 30,
  highlight: "#D4AF37",
  center: [-71.26435, 42.09093]                   // field centre
};

const $ = (id) => document.getElementById(id);
function showError(msg, err) {
  console.error(msg, err || "");
  $("errMsg").textContent = msg + (err && err.message ? " – " + err.message : "");
  $("errAlert").open = true;
}
const bootMsg = (t) => ($("bootMsg").textContent = t);

// -------------------------------------------------------------------------------------
// 1. Sign in (OAuth). Opened directly: same-window redirect. In an iframe (exb Embed):
//    popup + oauth-callback.html (needs a click).
// -------------------------------------------------------------------------------------
const [esriConfig, OAuthInfo, esriId, Portal, Graphic, GraphicsLayer] = await $arcgis.import([
  "@arcgis/core/config.js",
  "@arcgis/core/identity/OAuthInfo.js",
  "@arcgis/core/identity/IdentityManager.js",
  "@arcgis/core/portal/Portal.js",
  "@arcgis/core/Graphic.js",
  "@arcgis/core/layers/GraphicsLayer.js"
]);
const IN_FRAME = (() => { try { return window.self !== window.top; } catch { return true; } })();
esriConfig.portalUrl = CONFIG.portalUrl;
esriId.registerOAuthInfos([new OAuthInfo({ appId: CONFIG.appId, portalUrl: CONFIG.portalUrl, popup: IN_FRAME, popupCallbackUrl: "oauth-callback.html" })]);
const sharingUrl = CONFIG.portalUrl + "/sharing";

function framedSignIn() {
  return new Promise((resolve) => {
    bootMsg("Sign in to ArcGIS to open Game-Day Ops.");
    const card = document.querySelector(".boot-card");
    card.querySelector(".boot-bar")?.remove();
    const box = document.createElement("div");
    box.className = "boot-actions";
    box.innerHTML = `<button id="frameSignIn" class="pbtn pb-cancel">Sign in</button>
      <div class="boot-help">A small ArcGIS sign-in window will open. If nothing happens, allow pop-ups
      for this site, or <a href="${location.href}" target="_blank" rel="noopener">open the app in a new tab</a>.</div>`;
    card.appendChild(box);
    $("frameSignIn").addEventListener("click", async () => {
      $("frameSignIn").disabled = true;
      try { await esriId.getCredential(sharingUrl); box.remove(); resolve(); }
      catch (e) { $("frameSignIn").disabled = false; bootMsg("Sign-in didn't finish. Try again, or open the app in a new tab."); console.warn("[auth]", e); }
    });
  });
}
try {
  await esriId.checkSignInStatus(sharingUrl);
} catch {
  if (IN_FRAME) await framedSignIn();
  else { bootMsg("Redirecting to ArcGIS sign-in…"); await esriId.getCredential(sharingUrl); }
}
bootMsg("Opening the stadium…");
try {
  const portal = new Portal({ url: CONFIG.portalUrl, authMode: "immediate" });
  await portal.load();
  $("userName").textContent = portal.user?.fullName || portal.user?.username || "";
} catch (e) { showError("Signed in, but could not load your ArcGIS organization.", e); }
$("signOutBtn").addEventListener("click", () => { esriId.destroyCredentials(); window.location.reload(); });

// -------------------------------------------------------------------------------------
// 2. Map + layers (found by their fields, so renamed or grouped layers still work)
// -------------------------------------------------------------------------------------
await customElements.whenDefined("arcgis-map");
const mapEl = $("map");
mapEl.itemId = CONFIG.webmapId;
try { await mapEl.viewOnReady(); } catch (e) { showError("The web map could not be loaded. Check the item ID and that it is shared with you.", e); }
const view = mapEl.view;
const floorFilterEl = document.querySelector("arcgis-floor-filter");
try {
  const d = view.highlights?.find?.((h) => h.name === "default");
  if (d) { d.color = CONFIG.highlight; d.haloOpacity = 1; d.fillOpacity = 0.3; }
  else view.highlightOptions = { color: CONFIG.highlight, haloOpacity: 1, fillOpacity: 0.3 };
} catch (e) { console.warn("[highlight]", e); }
$("boot").classList.add("hide");

const flayers = view.map.allLayers.filter((l) => l.type === "feature").toArray();
await Promise.allSettled(flayers.map((l) => l.load()));
const L = {};
const byClass = {};
flayers.forEach((l) => { const c = classify(l); (byClass[c] ||= []).push(l); if (!L[c]) L[c] = l; });
console.info("[app] layers:", flayers.map((l) => `${l.title} → ${classify(l)}`).join(" | "));
["carts", "cameras", "guards", "posts", "incidents", "exits", "equip", "workorders", "stands", "restrooms", "zones", "sections"].forEach((c) => {
  if (!L[c]) console.warn(`[app] no layer found for "${c}". Is it in the web map?`);
});
// camera clicks open the CCTV viewer instead of the pop-up
if (L.cameras) L.cameras.popupEnabled = false;
// The two views. The 2D map is always loaded; the 3D scene loads the first time 3D is chosen.
const V2 = { el: mapEl, view, ff: floorFilterEl, L, byClass, is3d: false };
let V3 = null;
let act = V2;

// -------------------------------------------------------------------------------------
// 3. Data (small layers: query everything, filter in the app)
// -------------------------------------------------------------------------------------
const state = {};
async function q(layer, fields = ["*"], geometry = true) {
  if (!layer) return [];
  const query = layer.createQuery();
  query.where = "1=1"; query.outFields = fields; query.returnGeometry = geometry; query.returnZ = geometry;
  return (await layer.queryFeatures(query)).features;
}
async function loadData() {
  const keys = ["cameras", "guards", "posts", "incidents", "exits", "egress", "equip", "workorders", "stands", "restrooms", "zones", "cartReaders"];
  const res = await Promise.all(keys.map((k) => q(L[k]).catch((e) => { console.warn(`[data] ${k}`, e); return []; })));
  keys.forEach((k, i) => (state[k] = res[i]));
  state.sections = await q(L.sections, ["SECTION", "TIER", "SEATS", "DEMO_SCANNED_PCT", "LEVEL_ID"], false).catch(() => []);
}

// -------------------------------------------------------------------------------------
// 4. Map helpers
// -------------------------------------------------------------------------------------
let hl = null;
function showLayer(layer) {
  if (!layer) return;
  layer.visible = true;
  let p = layer.parent; while (p && p.type === "group") { p.visible = true; p = p.parent; }
}
// The same layer in the active view (the 3D scene has its own layer objects, found by the same field rules).
const lyrFor = (v, layer) => (!layer || v === V2 ? layer : v.L[classify(layer)] || null);
const KEYS = ["CAMERA_ID", "ASSET_ID", "WORK_ORDER", "STAND_ID", "RESTROOM_ID", "INCIDENT_ID", "GUARD_ID", "DOOR_ID", "UNIT_ID", "CART_ID", "READER_ID"];
async function goTo(g, layer, zoom = 20, popup = true) {
  const v = act;
  try {
    const a = g.attributes || {};
    if (a.LEVEL_ID) setFloor(v.view, v.ff, a.LEVEL_ID);
    const lyr = lyrFor(v, layer);
    showLayer(lyr);
    let target = g.geometry;
    if (v.is3d && target?.type === "point" && target.hasZ) { target = target.clone(); target.z += v.zShift; }   // data Z -> scene Z
    else if (v.is3d && target && target.type !== "point") target = target.extent?.center || target;
    await v.view.goTo(v.is3d ? { target, zoom, tilt: 60 } : { target, zoom }, { duration: 900 });
    hl?.remove(); hl = null;
    if (lyr) {
      let oid = a[layer.objectIdField];
      if (lyr !== layer && (lyr.url !== layer.url || lyr.layerId !== layer.layerId)) {   // different service: match on a business key
        const k = KEYS.find((f) => a[f] != null && lyr.fields?.some((x) => x.name === f));
        oid = null;
        if (k) {
          const q = lyr.createQuery(); q.where = `${k} = '${String(a[k]).replace(/'/g, "''")}'`;
          oid = (await lyr.queryObjectIds(q))?.[0] ?? null;
        }
      }
      if (oid != null) { const lv = await v.view.whenLayerView(lyr); hl = lv.highlight(oid); }
    }
    if (popup && lyr?.popupEnabled !== false) v.view.openPopup({ location: v.is3d ? anchor(target) : anchor(g.geometry), fetchFeatures: true });
  } catch (e) { console.warn("[goTo]", e); }
}
function lowerThird(title, sub) {
  const el = $("lowerThird");
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
  el.hidden = false;
  clearTimeout(lowerThird.t); lowerThird.t = setTimeout(() => (el.hidden = true), 6000);
}

// -------------------------------------------------------------------------------------
// 5. Ticker (game-day wire)
// -------------------------------------------------------------------------------------
const wire = [];
const TONE = { green: "#2E8B57", blue: "#2F6DB5", purple: "#6E4FA3", red: "#C8102E" };
function pushWire(text, t = "blue") {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  wire.unshift({ text, t, time });
  wire.splice(18);
  wireDirty = true;
}
let wireDirty = true;
function renderWire() {
  if (!wireDirty) return;
  wireDirty = false;
  const html = wire.map((w) => `<span class="tk-item" style="--tone:${TONE[w.t] || TONE.blue}"><i></i><time>${esc(w.time)}</time>${esc(w.text)}</span>`).join("");
  const run = $("tickerRun");
  run.innerHTML = html + html;                        // doubled for a seamless loop
  run.style.animationDuration = `${Math.max(30, run.scrollWidth / 2 / 70)}s`;
}
$("tickerRun").addEventListener("animationiteration", renderWire);

// -------------------------------------------------------------------------------------
// 6. Scenario views
// -------------------------------------------------------------------------------------
const MANAGED = {
  carts: ["cartReaders"],
  security: ["cameras", "coverage", "guards", "guardTracks", "posts", "incidents", "exits", "egress", "siteCams"],
  maint: ["equip", "workorders"],
  ops: ["stands", "restrooms"]
};
const ALL_MANAGED = [...new Set([...Object.values(MANAGED).flat(), "carts", "cartTrips", "cartDeliveries", "siteAssets"])];
const VIEW_META = {
  carts: { title: "VIP CART BOARD", kicker: "LIVE · SIMULATED", level: 3, zoom: 18.2, lt: ["VIP Cart Board", "Live cart positions, destinations and attendants"] },
  security: { title: "SECURITY DESK", kicker: "CAMERAS · POSTS · INCIDENTS", level: 1, zoom: 18.2, lt: ["Security Desk", "Cameras, guard posts, incidents and egress"] },
  maint: { title: "MAINTENANCE", kicker: "WORK ORDERS · ASSETS", level: 1, zoom: 18.2, lt: ["Maintenance", "Equipment status and open work orders"] },
  ops: { title: "OPERATIONS", kicker: "CONCESSIONS · RESTROOMS · LOTS", level: 1, zoom: 16.6, lt: ["Operations", "Concession and restroom waits, attendance, parking"] }
};
let current = "security";
let carts = null, boards = null;
async function setView(v, move = true) {
  current = v;
  document.body.className = document.body.className.replace(/\bview-\S+/g, "").trim() + ` view-${v}`;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  document.querySelectorAll(".board-body > section").forEach((s) => (s.hidden = s.dataset.v !== v));
  const m = VIEW_META[v];
  $("boardTitle").textContent = m.title; $("boardKicker").textContent = m.kicker;
  applyVisibility();
  carts?.setVisible(v === "carts");
  hl?.remove(); hl = null; act.view.closePopup?.();
  renderKpis();
  if (move) {
    setFloor(act.view, act.ff, LEVELS[m.level].id);
    act.view.goTo(act.is3d ? { center: CONFIG.center, zoom: m.zoom - 0.4, tilt: 58 } : { center: CONFIG.center, zoom: m.zoom, rotation: 0 }, { duration: 900 }).catch(() => {});
    lowerThird(...m.lt);
  }
}
function applyVisibility() {
  [V2, V3].filter(Boolean).forEach((vv) => {
    ALL_MANAGED.forEach((c) => (vv.byClass[c] || []).forEach((l) => (l.visible = MANAGED[current].includes(c))));
    MANAGED[current].forEach((c) => (vv.byClass[c] || []).forEach(showLayer));
  });
}

// -------------------------------------------------------------------------------------
// 6b. 2D / 3D switch. The scene loads on first use; boards, carts, KPIs and the ticker are shared.
// -------------------------------------------------------------------------------------
const sceneId = () => new URLSearchParams(location.search).get("scene") || CONFIG.websceneId;
async function ensureScene() {
  if (V3) return V3;
  const id = sceneId();
  if (!id) { showError("No 3D web scene is set yet. Add its item ID to CONFIG.websceneId in app.js, or open the app with ?scene=<item id>."); return null; }
  const el = $("scene");
  el.hidden = false; mapEl.hidden = true;                 // the scene needs a visible element to start
  $("dimSeg").classList.add("busy");
  try {
    await customElements.whenDefined("arcgis-scene");
    el.itemId = id;
    await el.viewOnReady();
  } catch (e) {
    showError("The 3D web scene could not be loaded. Check the item ID and that it is shared with you.", e);
    el.hidden = true; mapEl.hidden = false; $("dimSeg").classList.remove("busy");
    return null;
  }
  const sv = el.view;
  try {
    const d = sv.highlights?.find?.((h) => h.name === "default");
    if (d) { d.color = CONFIG.highlight; d.haloOpacity = 1; d.fillOpacity = 0.3; }
    else sv.highlightOptions = { color: CONFIG.highlight, haloOpacity: 1, fillOpacity: 0.3 };
  } catch { /* cosmetic */ }
  const fl = sv.map.allLayers.filter((l) => l.type === "feature").toArray();
  await Promise.allSettled(fl.map((l) => l.load()));
  const L3 = {}, by3 = {};
  fl.forEach((l) => { const c = classify(l); (by3[c] ||= []).push(l); if (!L3[c]) L3[c] = l; });
  console.info("[app] scene layers:", fl.map((l) => `${l.title} → ${classify(l)}`).join(" | "));
  if (L3.cameras) L3.cameras.popupEnabled = false;
  const zShift = style3D(sv, fl);
  V3 = { el, view: sv, ff: el.querySelector("arcgis-floor-filter"), L: L3, byClass: by3, is3d: true, zShift };
  carts?.attach(sv, V3.ff, true, zShift);
  boards?.attachView(sv, L3.cameras);
  $("dimSeg").classList.remove("busy");
  return V3;
}
// 3D presentation, applied in this app only (the web scene item is not changed):
//  • flat ground: the world terrain smooths over the stadium bowl and covers the field, so it is removed and the
//    stadium is lowered so the Event Level sits just above the basemap; campus buildings stand on the ground
//  • flat seating slabs (sections, seating rooms) and the 65k seats are hidden; seat rows become low steps by tier
//  • only section numbers are labelled
function style3D(sv, layers) {
  const zShift = -CONFIG.fieldZ + 0.3;
  try { sv.map.ground.layers.removeAll(); } catch (e) { console.warn("[3d] ground", e); }
  const step = (hex) => ({ type: "polygon-3d", symbolLayers: [{ type: "extrude", size: 0.45, material: { color: hex }, edges: { type: "solid", color: [255, 255, 255, 0.25], size: 0.5 } }] });
  layers.forEach((l) => {
    const c = classify(l);
    try {
      if (["zones", "lanes", "siteAssets", "siteCams", "sites"].includes(c)) l.elevationInfo = { mode: "on-the-ground" };
      else if (c === "facilities") l.elevationInfo = { mode: "absolute-height", featureExpressionInfo: { expression: "0.15" } };
      else l.elevationInfo = { mode: "absolute-height", offset: zShift };
      l.labelsVisible = c === "sections";
      if (c === "seats") { l.visible = false; l.listMode = "hide"; }
      if (c === "units") l.definitionExpression = [l.definitionExpression, "USE_TYPE NOT LIKE 'Seating%'"].filter(Boolean).map((x) => `(${x})`).join(" AND ");
      if (c === "sections") l.renderer = { type: "simple", symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill", material: { color: [0, 0, 0, 0] } }] } };
      if (c === "rows") l.renderer = { type: "unique-value", field: "TIER", defaultSymbol: step("#3a4a6b"),
        uniqueValueInfos: [["100", "#2b3b5e"], ["200", "#34466e"], ["CL", "#8e2a38"], ["300", "#3d5079"]].map(([value, hex]) => ({ value, symbol: step(hex) })) };
    } catch (e) { console.warn(`[3d] ${l.title}`, e); }
  });
  return zShift;
}
async function setDim(d) {
  const want3d = d === "3d";
  if (want3d === act.is3d) return;
  const from = act, lvl = currentLevel(from.view, from.ff);
  const center = from.view.center, zoom = from.view.zoom;
  if (want3d) { const v = await ensureScene(); if (!v) return; act = v; } else act = V2;
  V2.el.hidden = act !== V2;
  if (V3) V3.el.hidden = act !== V3;
  document.querySelectorAll("#dimSeg button").forEach((b) => b.classList.toggle("on", b.dataset.d === d));
  document.body.classList.toggle("is-3d", act.is3d);
  hl?.remove(); hl = null; from.view.closePopup?.();
  applyVisibility();
  carts?.setActive(act.view);
  setFloor(act.view, act.ff, lvl || LEVELS[VIEW_META[current].level].id);   // 3D never opens with every level stacked
  act.view.goTo(act.is3d ? { center, zoom: zoom - 0.4, tilt: 58 } : { center, zoom: zoom + 0.4, rotation: 0 }, { duration: 0 }).catch(() => {});
}
$("dimSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-d]"); if (b) setDim(b.dataset.d); });
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (b) setView(b.dataset.v); });
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, textarea, [contenteditable]")) return;
  const k = { 1: "security", 2: "carts", 3: "maint", 4: "ops" }[e.key];
  if (k && $("camModal").hidden) setView(k);
  if ((e.key === "d" || e.key === "D") && $("camModal").hidden) setDim(act.is3d ? "2d" : "3d");
  if (e.key === "]") document.body.classList.toggle("board-collapsed");
});
$("boardToggle").addEventListener("click", () => document.body.classList.add("board-collapsed"));
$("boardTab").addEventListener("click", () => document.body.classList.remove("board-collapsed"));

// -------------------------------------------------------------------------------------
// 7. KPIs (scorebug)
// -------------------------------------------------------------------------------------
let cartKpi = null;
const kpi = (val, label, t = "", sub = "") => `<div class="kpi ${t ? "k-" + t : ""}"><b>${val}${sub ? `<small>${sub}</small>` : ""}</b><span>${esc(label)}</span></div>`;
const A = (f) => f.attributes;
function renderKpis() {
  const el = $("kpis");
  if (current === "carts") {
    const k = cartKpi;
    el.innerHTML = k ? kpi(k.active, "Carts active", "green", `/${k.total}`) + kpi(k.lost, "Inactive", k.lost ? "purple" : "green") + kpi(k.avgEta, "Avg ETA", "blue")
      + kpi(k.served, "Deliveries", "") + kpi("$" + Math.round(k.sales / 1000 * 10) / 10 + "k", "Cart sales", "") : "";
    return;
  }
  const s = state;
  if (current === "security") {
    const cams = (s.cameras || []).map(A), on = cams.filter((a) => a.DEMO_STATUS === "Online").length;
    const inc = (s.incidents || []).map(A).filter((a) => a.DEMO_STATUS !== "Resolved").length;
    const posts = (s.posts || []).map(A).filter((a) => a.DEMO_STATUS !== "Covered").length;
    const exits = (s.exits || []).map(A).filter((a) => a.DEMO_STATUS === "Blocked").length;
    el.innerHTML = kpi(on, "Cameras online", on < cams.length ? "purple" : "green", `/${cams.length}`) + kpi(inc, "Open incidents", inc ? "red" : "green")
      + kpi(posts, "Post gaps", posts ? "red" : "green") + kpi(exits, "Exits blocked", exits ? "red" : "green") + kpi((s.guards || []).length, "Guards on duty", "blue");
  } else if (current === "maint") {
    const e = (s.equip || []).map(A), c = (st) => e.filter((a) => a.DEMO_STATUS === st).length;
    const wo = (s.workorders || []).map(A), p1 = wo.filter((a) => /^P1/.test(a.PRIORITY || "")).length;
    el.innerHTML = kpi(c("Down"), "Down", c("Down") ? "red" : "green") + kpi(c("Alarm"), "Alarm", c("Alarm") ? "red" : "green")
      + kpi(c("PM Due") + c("Inspection Due"), "PM / inspection", "purple") + kpi(wo.length, "Open work orders", "blue") + kpi(p1, "P1 emergency", p1 ? "red" : "green");
  } else {
    const st = (s.stands || []).map(A).filter((a) => a.DEMO_STATUS !== "Closed");
    const avg = st.length ? st.reduce((t, a) => t + (a.WAIT_MIN || 0), 0) / st.length : 0;
    const rr = (s.restrooms || []).map(A), busy = rr.filter((a) => a.DEMO_STATUS !== "Open").length;
    const lots = (s.zones || []).map(A).filter((a) => a.CAPACITY && a.DEMO_FILL_PCT != null && a.ZONE_TYPE === "Parking Lot");
    const full = lots.filter((a) => a.DEMO_STATUS === "Full").length;
    const sec = (s.sections || []).map(A), seats = sec.reduce((t, a) => t + (a.SEATS || 0), 0), in_ = sec.reduce((t, a) => t + (a.SEATS || 0) * (a.DEMO_SCANNED_PCT || 0) / 100, 0);
    el.innerHTML = kpi(seats ? Math.round((100 * in_) / seats) + "%" : "–", "Fans scanned in", "green") + kpi(avg.toFixed(1), "Avg stand wait", avg > 8 ? "purple" : "green", " min")
      + kpi(Math.max(0, ...st.map((a) => a.WAIT_MIN || 0)), "Longest wait", "red", " min") + kpi(busy, "Restrooms busy/closed", busy ? "purple" : "green") + kpi(full, "Lots full", "blue", `/${lots.length}`);
  }
}

// -------------------------------------------------------------------------------------
// 8. Boot the modules
// -------------------------------------------------------------------------------------
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }); }, 1000);
try {
  const { initCarts } = await import("./carts.js");
  carts = await initCarts({ view, floorFilterEl, Graphic, GraphicsLayer, boardEl: $("cartsBoard"), onEvent: pushWire,
    onKpi: (k) => { cartKpi = k; if (current === "carts") renderKpis(); } });
} catch (e) { showError("The VIP cart simulation failed to load.", e); }

async function refresh() {
  try { await loadData(); } catch (e) { showError("Could not load stadium data.", e); }
  boards?.render(state);
  renderKpis();
}
try {
  await loadData();
  const { initBoards } = await import("./boards.js");
  boards = initBoards({ view, L, state, goTo, setView: (v) => setView(v), els: { sec: $("secBoard"), maint: $("maintBoard"), ops: $("opsBoard") } });
  boards.render(state);
  // seed the wire from the model
  (state.incidents || []).map(A).filter((a) => a.DEMO_STATUS !== "Resolved").forEach((a) => pushWire(`${a.INCIDENT_TYPE}${a.SECTION ? " · Sec " + a.SECTION : ""}: ${a.DEMO_NOTE}`, tone(a.DEMO_STATUS) === "red" ? "red" : "purple"));
  (state.equip || []).map(A).filter((a) => ["Down", "Alarm"].includes(a.DEMO_STATUS)).forEach((a) => pushWire(`${a.NAME}: ${a.DEMO_ISSUE}`, "red"));
  (state.cameras || []).map(A).filter((a) => a.DEMO_STATUS !== "Online").forEach((a) => pushWire(`Camera ${a.CAMERA_ID} ${a.NAME} ${a.DEMO_STATUS.toLowerCase()}`, "purple"));
} catch (e) { showError("Stadium boards failed to load.", e); }
renderWire();
$("boardRefresh").addEventListener("click", refresh);
setInterval(refresh, CONFIG.refreshSeconds * 1000);
await setView("security", false);              // open on tab 1 (Security), on the web map's own saved view and floor; tabs move the map

// -------------------------------------------------------------------------------------
// 9. Home: the brand block resets everything to the opening view (2D, tab 1 Security, web map extent + floor)
// -------------------------------------------------------------------------------------
const home = { viewpoint: view.viewpoint?.clone?.() || null, level: currentLevel(view, floorFilterEl) };
async function resetAll() {
  $("camModal").hidden = true;
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  if (act.is3d) await setDim("2d");
  document.body.classList.remove("board-collapsed");
  carts?.reset();
  await setView("security", false);
  setFloor(view, floorFilterEl, home.level);
  view.closePopup?.();
  if (home.viewpoint) view.goTo(home.viewpoint, { duration: 900 }).catch(() => {});
  else view.goTo({ center: CONFIG.center, zoom: VIEW_META.carts.zoom, rotation: 0 }, { duration: 900 }).catch(() => {});
  lowerThird("Gillette Stadium", "Back to the opening view");
}
$("brandHome").addEventListener("click", resetAll);
window.addEventListener("keydown", (e) => {
  if (e.key === "Home" && !(e.target.closest && e.target.closest("input, textarea, [contenteditable]"))) resetAll();
});
// expose for console demos / testing
window.gil = { view, L, state, carts, setView, setDim, resetAll, get active() { return act; } };
