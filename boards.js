// =====================================================================================
// Security, Maintenance and Operations boards + the CCTV camera viewer.
// Data comes from the hosted layers (refreshed every 30 s by app.js). Camera stills are
// cams/<CAMERA_ID>.jpg, rendered from the Indoors model (source/render_cams.py).
// =====================================================================================
import { esc, tone, pill, levelName, levelNum, LEVELS, TONE_HEX } from "./layers.js";

const A = (f) => f.attributes;
const tn = (a) => tone(a.DEMO_STATUS, a.STATUS_TONE);
function li({ title, right, sub, t, onClick }) {
  const b = document.createElement("button");
  b.className = "li";
  b.style.setProperty("--tone", TONE_HEX[t] || "#556");
  b.innerHTML = `<b>${esc(title)}</b>${right || ""}${sub ? `<small>${esc(sub)}</small>` : ""}`;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
const stat = (v, label, t) => `<div class="stat k-${t}"><b>${v}</b><span>${esc(label)}</span></div>`;
const head = (t, s = "") => `<div class="sec-h">${esc(t)}${s ? `<small>${esc(s)}</small>` : ""}</div>`;
const SEV = { red: 0, purple: 1, blue: 2, green: 3, muted: 4 };

export function initBoards({ view, L, state, goTo, els }) {
  // ---------------------------------------------------------------- camera viewer
  const modal = document.getElementById("camModal");
  const screen = document.getElementById("camScreen");
  let camList = [], camIdx = 0, camFilter = "problems";
  const camGroup = (a) => {
    if (a.CAMERA_TYPE === "Panoramic" || a.CAMERA_TYPE === "PTZ" || a.ZONE === "Field") return "bowl";
    if (a.ZONE === "Gate") return "gates";
    if (/Club|Suite/.test(a.ZONE || "")) return "premium";
    if (a.ZONE === "Back of House") return "boh";
    return "concourse";
  };
  const fx = (a) => ({ Offline: "fx-offline", Degraded: "fx-degraded", Obstructed: "fx-obstructed" }[a.DEMO_STATUS] || "");
  function openCam(i, list) {
    camList = list || camList; camIdx = (i + camList.length) % camList.length;
    const g = camList[camIdx], a = A(g);
    document.getElementById("camImg").src = `cams/${a.CAMERA_ID}.jpg`;
    screen.className = "cam-screen " + fx(a);
    document.getElementById("camId").textContent = a.CAMERA_ID;
    document.getElementById("camName").textContent = (a.NAME || "").toUpperCase();
    document.getElementById("camWhere").textContent = `${(levelName(a.LEVEL_ID) || "").toUpperCase()} · ZONE ${String(a.ZONE || "").toUpperCase()}`;
    document.getElementById("camType").textContent = `${(a.CAMERA_TYPE || "").toUpperCase()} · ${a.FOV_DEG}° FOV`;
    document.getElementById("camStatus").innerHTML = pill(a.DEMO_STATUS, null, a.STATUS_TONE);
    const rows = [["Camera", a.CAMERA_ID], ["Name", a.NAME], ["Type", a.CAMERA_TYPE], ["Level", levelName(a.LEVEL_ID)], ["Zone", a.ZONE],
      ["Analytics", a.ANALYTICS], ["Range", a.RANGE_FT ? `${a.RANGE_FT} ft` : ""], ["Retention", a.RETENTION_DAYS ? `${a.RETENTION_DAYS} days` : ""], ["Note", a.DEMO_NOTE]];
    document.getElementById("camFacts").innerHTML = rows.filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    modal.hidden = false;
  }
  const closeCam = () => (modal.hidden = true);
  document.getElementById("camClose").addEventListener("click", closeCam);
  document.getElementById("camPrev").addEventListener("click", () => openCam(camIdx - 1));
  document.getElementById("camNext").addEventListener("click", () => openCam(camIdx + 1));
  document.getElementById("camMap").addEventListener("click", () => { const g = camList[camIdx]; closeCam(); goTo(g, L.cameras, 21, false); });
  modal.addEventListener("click", (e) => { if (e.target === modal) closeCam(); });
  window.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") closeCam();
    if (e.key === "ArrowRight") openCam(camIdx + 1);
    if (e.key === "ArrowLeft") openCam(camIdx - 1);
  });
  setInterval(() => {
    if (modal.hidden) return;
    const d = new Date();
    document.getElementById("camTime").textContent = `${d.toLocaleDateString("en-CA")} ${d.toLocaleTimeString("en-GB")}`;
  }, 250);
  // click a camera on the map (2D or 3D) -> viewer
  function bindCamClick(v, camLayer) {
    if (!camLayer) return;
    v.on("click", async (e) => {
    if (!camLayer.visible) return;
    try {
      const hit = await v.hitTest(e, { include: [camLayer] });
      const r = hit.results.find((x) => x.graphic?.layer === camLayer);
      if (!r) return;
      const id = r.graphic.attributes?.CAMERA_ID;
      const list = sortedCams();
      const i = list.findIndex((g) => A(g).CAMERA_ID === id);
      if (i >= 0) openCam(i, list);
    } catch (err) { console.warn("[cam click]", err); }
    });
  }
  bindCamClick(view, L.cameras);
  const sortedCams = () => [...(state.cameras || [])].sort((x, y) => SEV[tn(A(x))] - SEV[tn(A(y))] || A(x).CAMERA_ID.localeCompare(A(y).CAMERA_ID));

  // ---------------------------------------------------------------- security
  function renderSecurity() {
    const el = els.sec;
    const cams = sortedCams();
    const ca = cams.map(A);
    const inc = (state.incidents || []).filter((g) => A(g).DEMO_STATUS !== "Resolved");
    const posts = (state.posts || []).filter((g) => A(g).DEMO_STATUS !== "Covered");
    const exits = (state.exits || []).filter((g) => A(g).DEMO_STATUS === "Blocked");
    const guards = (state.guards || []).map(A);
    el.innerHTML = `<div class="stat-row">
        ${stat(`${ca.filter((a) => a.DEMO_STATUS === "Online").length}/${ca.length}`, "Cameras online", ca.some((a) => a.DEMO_STATUS !== "Online") ? "purple" : "green")}
        ${stat(inc.length, "Open incidents", inc.length ? "red" : "green")}
        ${stat(posts.length, "Post gaps", posts.length ? "red" : "green")}
        ${stat(exits.length, "Exits blocked", exits.length ? "red" : "green")}
        ${stat(guards.filter((a) => a.DEMO_STATUS === "Responding").length, "Guards responding", "purple")}
      </div>
      ${head("Camera wall", "click a feed, or a camera on the map")}
      <div class="chips" id="camChips">${[["problems", "Problems"], ["bowl", "Bowl"], ["concourse", "Concourses"], ["gates", "Gates"], ["premium", "Club & suites"], ["boh", "Back of house"], ["all", "All"]]
        .map(([k, t]) => `<button data-k="${k}" class="${camFilter === k ? "on" : ""}">${t}</button>`).join("")}</div>
      <div class="camwall" id="camWall"></div>
      ${head("Incidents", "live")}<div class="list" id="incList"></div>
      ${head("Guard posts needing staff")}<div class="list" id="postList"></div>
      ${head("Blocked exits", "egress re-routed")}<div class="list" id="exitList"></div>
      <p class="fineprint">Camera stills are rendered from the 3D Indoors model with a synthetic crowd. Statuses, guards and incidents are synthetic demo data.</p>`;
    const wall = el.querySelector("#camWall");
    let list = camFilter === "all" ? cams : camFilter === "problems" ? cams.filter((g) => A(g).DEMO_STATUS !== "Online") : cams.filter((g) => camGroup(A(g)) === camFilter);
    if (camFilter === "problems") {      // problems first, then a few high-value feeds
      const extra = cams.filter((g) => A(g).DEMO_STATUS === "Online" && (A(g).CAMERA_TYPE === "Panoramic" || A(g).ZONE === "Gate")).slice(0, 8);
      list = [...list, ...extra];
    }
    list.forEach((g, i) => {
      const a = A(g), t = tn(a);
      const b = document.createElement("button");
      b.className = `thumb st-${t} ${fx(a)}`;
      b.title = `${a.CAMERA_ID} · ${a.NAME} · ${a.DEMO_STATUS}`;
      b.innerHTML = a.DEMO_STATUS === "Offline" ? `<div class="nosig"><span>NO SIGNAL</span></div>` : `<img loading="lazy" src="cams/${esc(a.CAMERA_ID)}.jpg" alt="">`;
      b.innerHTML += `<span class="tid">${esc(a.CAMERA_ID.replace("GIL-", ""))}</span><span class="tdot"></span>`;
      b.addEventListener("click", () => openCam(i, list));
      wall.appendChild(b);
    });
    el.querySelector("#camChips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; camFilter = b.dataset.k; renderSecurity(); });
    const il = el.querySelector("#incList");
    inc.sort((x, y) => SEV[tn(A(x))] - SEV[tn(A(y))]).forEach((g) => {
      const a = A(g);
      il.appendChild(li({ title: `${a.INCIDENT_TYPE}${a.SECTION ? " · Section " + a.SECTION : ""}`, right: pill(a.DEMO_STATUS, null, a.STATUS_TONE),
        sub: `${a.REPORTED || ""} · ${levelName(a.LEVEL_ID)} · ${a.DEMO_NOTE || ""}`, t: tn(a), onClick: () => goTo(g, L.incidents, 21) }));
    });
    if (!inc.length) il.innerHTML = `<div class="fineprint">No open incidents.</div>`;
    const pl = el.querySelector("#postList");
    posts.forEach((g) => {
      const a = A(g);
      pl.appendChild(li({ title: a.NAME, right: pill(a.DEMO_STATUS, `${a.STAFF_PRESENT}/${a.STAFF_REQUIRED}`, a.STATUS_TONE),
        sub: `${a.POST_TYPE} · ${levelName(a.LEVEL_ID)} · ${a.DEMO_STATUS}`, t: tn(a), onClick: () => goTo(g, L.posts, 21) }));
    });
    if (!posts.length) pl.innerHTML = `<div class="fineprint">All posts covered.</div>`;
    const xl = el.querySelector("#exitList");
    exits.forEach((g) => {
      const a = A(g);
      xl.appendChild(li({ title: a.NAME, right: pill(a.DEMO_STATUS, null, a.STATUS_TONE), sub: `${a.EXIT_TYPE} · ${levelName(a.LEVEL_ID)}${a.DEMO_NOTE ? " · " + a.DEMO_NOTE : ""}`,
        t: tn(a), onClick: () => goTo(g, L.exits, 21) }));
    });
    if (!exits.length) xl.innerHTML = `<div class="fineprint">All exits clear.</div>`;
  }

  // ---------------------------------------------------------------- maintenance
  const PRI = (p) => (/^P1/.test(p) ? "red" : /^P2/.test(p) ? "purple" : "blue");
  function renderMaint() {
    const el = els.maint;
    const eq = (state.equip || []).map(A);
    const c = (s) => eq.filter((a) => a.DEMO_STATUS === s).length;
    const wos = [...(state.workorders || [])].sort((x, y) => String(A(x).PRIORITY).localeCompare(String(A(y).PRIORITY)) || String(A(x).OPENED).localeCompare(String(A(y).OPENED)));
    el.innerHTML = `<div class="stat-row">${stat(c("Down"), "Down", c("Down") ? "red" : "green")}${stat(c("Alarm"), "Alarm", c("Alarm") ? "red" : "green")}
        ${stat(c("PM Due"), "PM due", "purple")}${stat(c("Inspection Due"), "Inspection due", "purple")}${stat(c("Running"), "Running", "green")}</div>
      ${head("Work orders", `${wos.length} open · by priority`)}<div class="list" id="woList"></div>
      ${head("Equipment by class")}<div class="mtx" id="eqMtx"></div>
      ${head("Needs attention")}<div class="list" id="eqList"></div>
      <p class="fineprint">Equipment statuses and work orders are synthetic demo data.</p>`;
    const wl = el.querySelector("#woList");
    wos.forEach((g) => {
      const a = A(g);
      wl.appendChild(li({ title: `${a.WORK_ORDER} · ${a.ASSET_NAME}`, right: pill(a.PRIORITY, a.PRIORITY, PRI(a.PRIORITY)),
        sub: `${a.DESCRIPTION || ""} · ${a.ASSIGNED_TO} · opened ${a.OPENED} · ${a.DEMO_STATUS}`, t: PRI(a.PRIORITY), onClick: () => goTo(g, L.workorders, 21) }));
    });
    const classes = [...new Set(eq.map((a) => a.EQUIP_CLASS))].sort();
    const cols = [["Down", "red"], ["Alarm", "red"], ["Due", "purple"], ["OK", "green"]];
    el.querySelector("#eqMtx").innerHTML = `<div class="h" style="text-align:left">Class</div>${cols.map(([k]) => `<div class="h">${k}</div>`).join("")}` +
      classes.map((k) => {
        const r = eq.filter((a) => a.EQUIP_CLASS === k);
        const n = [r.filter((a) => a.DEMO_STATUS === "Down").length, r.filter((a) => a.DEMO_STATUS === "Alarm").length,
          r.filter((a) => /Due/.test(a.DEMO_STATUS)).length, r.filter((a) => a.DEMO_STATUS === "Running").length];
        return `<div>${esc(k)}</div>${n.map((v, i) => `<div class="n ${v ? "" : "z"}" style="${v && i < 3 ? `color:${TONE_HEX[cols[i][1]] === TONE_HEX.red ? "#ff6a7d" : "#b393ff"}` : ""}">${v}</div>`).join("")}`;
      }).join("");
    const al = el.querySelector("#eqList");
    (state.equip || []).filter((g) => A(g).DEMO_STATUS !== "Running").sort((x, y) => SEV[tn(A(x))] - SEV[tn(A(y))]).forEach((g) => {
      const a = A(g);
      const temp = a.DEMO_TEMP_F != null && a.DEMO_SETPOINT_F != null ? ` · ${a.DEMO_TEMP_F}°F (set ${a.DEMO_SETPOINT_F}°F)` : "";
      al.appendChild(li({ title: a.NAME, right: pill(a.DEMO_STATUS, null, a.STATUS_TONE), sub: `${a.EQUIP_CLASS} · ${levelName(a.LEVEL_ID)} · ${a.DEMO_ISSUE || ""}${temp}`,
        t: tn(a), onClick: () => goTo(g, L.equip, 21) }));
    });
  }

  // ---------------------------------------------------------------- operations
  let opsLevel = "all";
  function renderOps() {
    const el = els.ops;
    const stands = (state.stands || []).filter((g) => opsLevel === "all" || levelNum(A(g).LEVEL_ID) === Number(opsLevel));
    const rr = (state.restrooms || []).filter((g) => opsLevel === "all" || levelNum(A(g).LEVEL_ID) === Number(opsLevel));
    const lots = (state.zones || []).filter((g) => A(g).ZONE_TYPE === "Parking Lot" && A(g).CAPACITY);
    const sec = (state.sections || []).map(A);
    const tiers = {};
    sec.forEach((a) => { const t = (tiers[a.TIER] ||= { seats: 0, in: 0 }); t.seats += a.SEATS || 0; t.in += (a.SEATS || 0) * (a.DEMO_SCANNED_PCT || 0) / 100; });
    const lvls = [...new Set((state.stands || []).map((g) => levelNum(A(g).LEVEL_ID)))].filter((x) => x !== null).sort();
    el.innerHTML = `<div class="chips" id="opsLv"><button data-l="all" class="${opsLevel === "all" ? "on" : ""}">All levels</button>${lvls.map((l) => `<button data-l="${l}" class="${String(opsLevel) === String(l) ? "on" : ""}">${esc(LEVELS[l]?.name || l)}</button>`).join("")}</div>
      ${head("Longest concession waits", "minutes")}<div id="standLb"></div>
      ${head("Sold out / closed")}<div class="list" id="soldList"></div>
      ${head("Restrooms", "busy, cleaning or closed")}<div class="list" id="rrList"></div>
      ${head("Fans scanned in", "by tier")}<div id="tierLb"></div>
      ${head("Parking", "fill by lot")}<div id="lotLb"></div>
      <p class="fineprint">Wait times, scans and lot fill are synthetic demo data.</p>`;
    el.querySelector("#opsLv").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; opsLevel = b.dataset.l; renderOps(); });
    const lb = el.querySelector("#standLb");
    const open = stands.filter((g) => A(g).DEMO_STATUS !== "Closed").sort((x, y) => (A(y).WAIT_MIN || 0) - (A(x).WAIT_MIN || 0)).slice(0, 10);
    const maxW = Math.max(1, ...open.map((g) => A(g).WAIT_MIN || 0));
    open.forEach((g, i) => {
      const a = A(g), w = a.WAIT_MIN || 0, t = w >= 12 ? "red" : w >= 8 ? "purple" : "green";
      const r = document.createElement("div");
      r.className = "leader";
      r.innerHTML = `<span class="rk">${i + 1}</span><span class="nm"><b>${esc(a.NAME)}</b><small>Sec ${esc(a.NEAR_SECTION)} · ${esc(LEVELS[levelNum(a.LEVEL_ID)]?.short || "")} · queue ${a.QUEUE_LEN ?? "–"}${a.MOBILE_ORDER === "Yes" ? " · mobile order" : ""}</small></span>
        <span class="hbar" style="--tone:${TONE_HEX[t]}"><i style="width:${(100 * w) / maxW}%"></i></span><span class="val">${w}</span>`;
      r.addEventListener("click", () => goTo(g, L.stands, 21));
      lb.appendChild(r);
    });
    const sl = el.querySelector("#soldList");
    stands.filter((g) => ["Sold Out - Item", "Closed"].includes(A(g).DEMO_STATUS)).forEach((g) => {
      const a = A(g);
      sl.appendChild(li({ title: a.NAME, right: pill(a.DEMO_STATUS, null, a.STATUS_TONE), sub: `Sec ${a.NEAR_SECTION} · ${levelName(a.LEVEL_ID)}${a.SOLD_OUT_ITEM ? " · out of " + a.SOLD_OUT_ITEM : ""}`,
        t: tn(a), onClick: () => goTo(g, L.stands, 21) }));
    });
    if (!sl.children.length) sl.innerHTML = `<div class="fineprint">Nothing sold out.</div>`;
    const rl = el.querySelector("#rrList");
    rr.filter((g) => A(g).DEMO_STATUS !== "Open").sort((x, y) => SEV[tn(A(x))] - SEV[tn(A(y))]).forEach((g) => {
      const a = A(g);
      rl.appendChild(li({ title: a.NAME, right: pill(a.DEMO_STATUS, null, a.STATUS_TONE),
        sub: `${levelName(a.LEVEL_ID)} · wait ${a.WAIT_MIN ?? "–"} min · ${a.OCCUPANCY_PCT ?? "–"}% full · supplies ${a.SUPPLIES || "–"}${a.DEMO_NOTE ? " · " + a.DEMO_NOTE : ""}`,
        t: tn(a), onClick: () => goTo(g, L.restrooms, 21) }));
    });
    if (!rl.children.length) rl.innerHTML = `<div class="fineprint">All restrooms open.</div>`;
    const bars = (host, rows) => rows.forEach(([name, sub, pct, t, onClick]) => {
      const r = document.createElement("div");
      r.className = "leader";
      r.style.gridTemplateColumns = "1fr 130px 50px";
      r.innerHTML = `<span class="nm"><b>${esc(name)}</b><small>${esc(sub)}</small></span><span class="hbar" style="--tone:${TONE_HEX[t]}"><i style="width:${pct}%"></i></span><span class="val">${Math.round(pct)}%</span>`;
      if (onClick) r.addEventListener("click", onClick);
      host.appendChild(r);
    });
    bars(el.querySelector("#tierLb"), Object.entries(tiers).sort().map(([k, v]) => [{ 100: "Lower bowl (100s)", 200: "Mezzanine (200s)", CL: "Club seats", 300: "Upper bowl (300s)" }[k] || k, `${Math.round(v.in).toLocaleString()} of ${v.seats.toLocaleString()} seats`, v.seats ? (100 * v.in) / v.seats : 0, "green"]));
    bars(el.querySelector("#lotLb"), lots.sort((x, y) => (A(y).CAPACITY || 0) - (A(x).CAPACITY || 0)).slice(0, 10).map((g) => {
      const a = A(g);
      return [a.NAME, `${a.LOT_TYPE || ""} · ${a.CAPACITY} spaces`, a.DEMO_FILL_PCT || 0, a.DEMO_FILL_PCT >= 98 ? "red" : a.DEMO_FILL_PCT >= 90 ? "purple" : "blue",
        () => goTo(g, L.zones, 17, false)];
    }));
  }

  return {
    render() { renderSecurity(); renderMaint(); renderOps(); },
    attachView: (v, camLayer) => bindCamClick(v, camLayer),
    openCam
  };
}
