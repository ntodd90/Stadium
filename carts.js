// =====================================================================================
// VIP cart board: live cart simulation, map labels, dashboard, Cancel / Reassign menus.
//  • Routing: Dijkstra on data/navgraph.json, a walkable graph built from the Indoors units
//    (2.5 m grid per level, freight elevators FE-NE/SE/SW/NW between levels). FE-SW is in
//    Alarm in the model, so routes avoid it.
//  • Everything here is synthetic and app-session only: Cancel / Reassign change the
//    simulation in this browser tab, nothing is written back to the hosted layers.
// =====================================================================================
import { LEVELS, esc, tone, TONE_HEX, setFloor, currentLevel } from "./layers.js";

const SPEED_MS = 1.5;          // cart speed (m/s, sim time)
const SERVICE_S = 70;          // dwell at a suite / seat block
const STOCK_S = 90;            // restock at the hub
const LIFT_S = (dl) => 14 + 7 * dl;
const BLOCKED_LIFTS = ["FE-SW"];
const STATUS = { travel: "En Route", back: "Returning", service: "Servicing", stock: "Stocking", hold: "Holding" };
const EXTRA_STAFF = ["Jordan Pike", "Sam Whitfield", "Erin Coyle", "Nate Ramos"];

// ---------------------------------------------------------------------------- graph
function buildGraph(G) {
  const n = G.x.length, deg = new Int32Array(n + 1);
  const blocked = new Set();
  BLOCKED_LIFTS.forEach((k) => Object.values(G.elevators[k] || {}).forEach((id) => blocked.add(id)));
  for (let i = 0; i < G.e.length; i += 2) { deg[G.e[i] + 1]++; deg[G.e[i + 1] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const to = new Int32Array(G.e.length), w = new Float32Array(G.e.length), fill = deg.slice(0, n);
  for (let k = 0; k < G.e.length / 2; k++) {
    const a = G.e[2 * k], b = G.e[2 * k + 1];
    to[fill[a]] = b; w[fill[a]++] = G.w[k];
    to[fill[b]] = a; w[fill[b]++] = G.w[k];
  }
  const lift = {};
  Object.entries(G.elevators).forEach(([name, m]) => Object.values(m).forEach((id) => (lift[id] = name)));
  return { n, start: deg, to, w, blocked, lift, x: G.x, y: G.y, l: G.l };
}

function dijkstra(g, src, dst) {
  const dist = new Float64Array(g.n).fill(Infinity), prev = new Int32Array(g.n).fill(-1);
  const heap = [[0, src]]; dist[src] = 0;
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === dst) break;
    if (d > dist[u]) continue;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.to[k];
      if (g.blocked.has(v)) continue;
      const nd = d + g.w[k];
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); }
    }
  }
  if (!isFinite(dist[dst])) return null;
  const path = [];
  for (let u = dst; u !== -1; u = prev[u]) path.push(u);
  return path.reverse();
}

function nearestNode(g, x, y, l) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.n; i++) {
    if (g.l[i] !== l || g.blocked.has(i)) continue;
    const d = (g.x[i] - x) ** 2 + (g.y[i] - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------- module
export async function initCarts({ view, floorFilterEl, Graphic, GraphicsLayer, boardEl, onEvent, onKpi, base = "." }) {
  const [G, C] = await Promise.all([
    fetch(`${base}/data/navgraph.json`).then((r) => r.json()),
    fetch(`${base}/data/carts.json`).then((r) => r.json())
  ]);
  const g = buildGraph(G);
  const dests = G.dests.filter((d) => d.kind !== "Hub");
  const hub = G.dests.find((d) => d.kind === "Hub") || G.dests.find((d) => /HUB/.test(d.id));
  const destByName = Object.fromEntries(G.dests.map((d) => [d.name, d]));
  const destById = Object.fromEntries(G.dests.map((d) => [d.id, d]));
  const A = G.affine;
  const zOf = (l) => G.fieldZ + (G.levels[String(l)]?.elev || 0);         // floor elevation, NAVD88 m (same as the Indoors data)
  const merc = (x, y, sr) => {
    const lon = A.lon[0] * x + A.lon[1] * y + A.lon[2], lat = A.lat[0] * x + A.lat[1] * y + A.lat[2];
    if (sr && !sr.isWebMercator) return { x: lon, y: lat, spatialReference: { wkid: 4326 } };
    return { x: (lon * 20037508.34) / 180, y: (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (20037508.34 / 180), spatialReference: { wkid: 102100 } };
  };
  // Views: the 2D map and (when opened) the 3D scene. Each keeps its own graphics; only the active one is redrawn.
  const V = [];
  let act = null;
  const geomFor = (v, x, y, l, dz = 0.9) => {
    const m = merc(x, y, v.view.spatialReference);
    return v.is3d ? { type: "point", ...m, z: zOf(l) + dz + v.zShift } : { type: "point", ...m };
  };
  const attendants = [...new Set([...C.carts.map((c) => c.attendant), ...EXTRA_STAFF])];

  // --------------------------------------------------------------------------- carts
  const carts = C.carts.map((c) => {
    const plan = c.stops.map((n) => destByName[n]).filter(Boolean);
    const cart = {
      id: c.id, name: c.name, attendant: c.attendant, tag: c.tag, order: c.order, stock: c.stock, battery: c.battery,
      served: c.served, sales: c.sales, lastSeen: c.lastSeen, assignment: c.assignment, plan, queue: [...plan],
      x: c.x, y: c.y, l: c.level, path: null, seg: 0, segT: 0, mode: "hold", dwell: 0, goal: null, lift: null,
      lost: null, prevMode: null, eta: 0
    };
    const at = (d) => { const nid = d.node; cart.node = nid; cart.x = g.x[nid]; cart.y = g.y[nid]; cart.l = g.l[nid]; };
    if (c.status === "Servicing" && plan.length) { at(plan[0]); cart.goal = plan[0]; cart.queue = plan.slice(1); cart.mode = "service"; cart.dwell = 15 + Math.random() * 45; }
    else if (c.status === "Stocking") { at(hub); cart.mode = "stock"; cart.dwell = 20 + Math.random() * 60; cart.stock = Math.min(cart.stock, 60); }
    else if (c.status === "Returning") { cart.node = nearestNode(g, c.x, c.y, c.level); cart.queue = []; routeTo(cart, hub, "back"); }
    else if (c.status === "En Route") { cart.node = nearestNode(g, c.x, c.y, c.level); cart.queue = plan.slice(1); routeTo(cart, plan[0], "travel"); }
    else { cart.lost = c.status; cart.mode = "lost"; cart.where = c.where; cart.room = c.room; cart.spot = c.spot; cart.idle = c.idle; cart.node = nearestNode(g, c.x, c.y, c.level); }
    return cart;
  });

  function routeTo(cart, dest, mode) {
    const moving = (cart.mode === "travel" || cart.mode === "back") && cart.path;
    let src = moving ? cart.path[Math.min(cart.seg + 1, cart.path.length - 1)]
      : cart.node != null && g.x[cart.node] === cart.x && g.y[cart.node] === cart.y ? cart.node : nearestNode(g, cart.x, cart.y, cart.l);
    if (g.blocked.has(src)) src = nearestNode(g, g.x[src], g.y[src], g.l[src]);
    const p = dijkstra(g, src, dest.node);
    if (!p) { onEvent?.(`${cart.id}: no route to ${dest.name}`, "red"); return false; }
    // start from the cart's current point (it may be mid-segment)
    cart.path = p; cart.seg = 0; cart.segT = 0; cart.goal = dest; cart.mode = mode; cart.lift = null;
    if (cart.x !== g.x[p[0]] || cart.y !== g.y[p[0]]) { cart.lead = { x: cart.x, y: cart.y }; } else cart.lead = null;
    return true;
  }

  const segInfo = (cart, i) => {
    const a = cart.path[i], b = cart.path[i + 1];
    if (g.l[a] !== g.l[b]) return { lift: true, t: LIFT_S(Math.abs(g.l[b] - g.l[a])), a, b };
    const ax = i === 0 && cart.lead ? cart.lead.x : g.x[a], ay = i === 0 && cart.lead ? cart.lead.y : g.y[a];
    return { lift: false, t: Math.hypot(g.x[b] - ax, g.y[b] - ay) / SPEED_MS, a, b, ax, ay };
  };

  function remaining(cart) {
    if (!cart.path) return 0;
    let t = 0;
    for (let i = cart.seg; i < cart.path.length - 1; i++) t += segInfo(cart, i).t;
    return Math.max(0, t - cart.segT);
  }

  function arrive(cart) {
    cart.node = cart.path[cart.path.length - 1]; cart.path = null; cart.lead = null; cart.lift = null;
    if (cart.goal === hub) {
      cart.mode = "stock"; cart.dwell = STOCK_S;
      onEvent?.(`${cart.id} back at VIP Cart Staging, restocking`, "blue");
    } else {
      cart.mode = "service"; cart.dwell = SERVICE_S;
      onEvent?.(`${cart.id} arrived at ${cart.goal.name} (${LEVELS[cart.l].name})`, "green");
    }
  }

  function step(cart, dt) {
    if (cart.mode === "lost" || cart.mode === "hold") return;
    if (cart.mode === "service" || cart.mode === "stock") {
      cart.dwell -= dt;
      cart.battery = Math.max(3, cart.battery - dt * 0.0012);
      if (cart.dwell > 0) return;
      if (cart.mode === "service") {
        cart.served += 1; cart.sales += 60 + Math.round(Math.random() * 180);
        cart.stock = Math.max(5, cart.stock - (8 + Math.round(Math.random() * 7)));
        cart.order = "ORD-" + (5300 + Math.floor(Math.random() * 600));
      } else {
        cart.stock = 100; cart.battery = Math.min(100, cart.battery + 6);
        if (!cart.queue.length) cart.queue = [...cart.plan];
      }
      if (cart.mode === "service" && cart.stock < 25) { cart.queue = cart.queue.length ? cart.queue : []; routeTo(cart, hub, "back"); onEvent?.(`${cart.id} low on stock, heading back to staging`, "blue"); return; }
      const next = cart.queue.shift();
      if (next) routeTo(cart, next, "travel");
      else if (cart.mode === "service") routeTo(cart, hub, "back");
      else if (cart.plan.length) { cart.queue = cart.plan.slice(1); routeTo(cart, cart.plan[0], "travel"); }
      return;
    }
    // travelling
    let left = dt;
    cart.battery = Math.max(3, cart.battery - dt * 0.003);
    while (left > 0 && cart.path) {
      if (cart.seg >= cart.path.length - 1) { arrive(cart); return; }
      const s = segInfo(cart, cart.seg);
      const need = s.t - cart.segT;
      if (left < need) {
        cart.segT += left; left = 0;
        const f = cart.segT / s.t;
        if (s.lift) { cart.x = g.x[s.a]; cart.y = g.y[s.a]; cart.l = f < 0.5 ? g.l[s.a] : g.l[s.b]; cart.lift = { name: g.lift[s.a] || "Freight elevator", up: g.l[s.b] > g.l[s.a] }; }
        else { cart.x = s.ax + (g.x[s.b] - s.ax) * f; cart.y = s.ay + (g.y[s.b] - s.ay) * f; cart.l = g.l[s.b]; cart.lift = null; }
      } else {
        left -= need; cart.seg += 1; cart.segT = 0; cart.lead = null;
        cart.x = g.x[s.b]; cart.y = g.y[s.b]; cart.l = g.l[s.b]; cart.lift = null;
      }
    }
  }

  // --------------------------------------------------------------------------- map graphics
  const statusOf = (c) => (c.mode === "lost" ? c.lost : STATUS[c.mode] || c.mode);
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]; };
  const opts = { floorsOnly: false, routes: true, speed: 1, selected: null, follow: false, visible: true };
  const resetSyms = () => V.forEach((v) => (v.last = {}));
  const OFF3 = { screenLength: 24, maxWorldLength: 40, minWorldLength: 1.5 };     // 3D: lift the marker off the floor, with a callout

  function attach(view, ff, is3d, zShift = 0) {
    const elev = is3d ? { elevationInfo: { mode: "absolute-height" } } : {};
    const v = { view, ff, is3d, zShift, last: {}, gr: {}, drawn: 0,
      layer: new GraphicsLayer({ title: "VIP carts (live simulation)", listMode: "hide", ...elev }),
      routeLayer: new GraphicsLayer({ title: "VIP cart routes", listMode: "hide", ...elev }) };
    view.map.addMany([v.routeLayer, v.layer]);
    carts.forEach((c) => {
      const p = geomFor(v, c.x, c.y, c.l);
      const o = { pulse: new Graphic({ geometry: p }), dot: new Graphic({ geometry: p, attributes: { cartId: c.id } }),
        label: new Graphic({ geometry: p, attributes: { cartId: c.id } }), pt: 0 };
      v.gr[c.id] = o;
      v.layer.addMany([o.pulse, o.dot, o.label]);
    });
    v.layer.visible = v.routeLayer.visible = opts.visible;
    view.on("click", async (e) => {
      if (!opts.visible || act !== v) return;
      try {
        const hit = await view.hitTest(e, { include: [v.layer] });
        const r = hit.results.find((x) => x.graphic?.attributes?.cartId);
        if (r) {
          const c = carts.find((x) => x.id === r.graphic.attributes.cartId);
          view.closePopup?.();
          select(c, false);
          c.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      } catch { /* ignore */ }
    });
    V.push(v);
    if (!act) act = v;
    return v;
  }

  function symDot(v, t, a, sel) {
    if (!v.is3d) return { type: "simple-marker", style: "circle", size: sel ? 20 : 16, color: hexA(TONE_HEX[t], a), outline: { color: [255, 255, 255, a], width: sel ? 3 : 2 } };
    return { type: "point-3d", verticalOffset: OFF3,
      callout: { type: "line", size: 1.5, color: [255, 255, 255, 0.85 * a], border: { color: [11, 23, 48, 0.5 * a] } },
      symbolLayers: [{ type: "icon", resource: { primitive: "circle" }, size: sel ? 18 : 14, material: { color: hexA(TONE_HEX[t], a) },
        outline: { color: [255, 255, 255, a], size: sel ? 2.5 : 1.5 } }] };
  }
  function symLabel(v, c, t, a) {
    const text = `${c.id}  ·  ${c.lift ? (c.lift.up ? "▲ " : "▼ ") : ""}${LEVELS[c.l]?.tag || ""}`;
    if (!v.is3d) return { type: "text", text, color: [255, 255, 255, a], backgroundColor: [11, 23, 48, 0.88 * a], borderLineColor: hexA(TONE_HEX[t], a),
      borderLineSize: 1.5, haloSize: 0, font: { family: "Arial", size: 10, weight: "bold" }, yOffset: 19, horizontalAlignment: "center" };
    return { type: "point-3d", verticalOffset: { screenLength: 46, maxWorldLength: 70, minWorldLength: 3 },
      symbolLayers: [{ type: "text", text, size: 9.5, material: { color: [255, 255, 255, a] }, background: { color: [11, 23, 48, 0.88 * a] },
        font: { family: "Arial", weight: "bold" } }] };
  }
  function symPulse(v, c, p) {
    const col = c.mode === "lost" ? [110, 79, 163, (1 - p) * 0.95] : [212, 175, 55, (1 - p) * 0.9];
    if (!v.is3d) return { type: "simple-marker", style: "circle", size: 16 + 26 * p, color: [0, 0, 0, 0], outline: { color: col, width: 3 } };
    return { type: "point-3d", verticalOffset: OFF3,
      symbolLayers: [{ type: "icon", resource: { primitive: "circle" }, size: 14 + 22 * p, material: { color: [0, 0, 0, 0] }, outline: { color: col, size: 2.5 } }] };
  }
  function draw(now) {
    const v = act;
    if (!v) return;
    if (v.is3d && now - v.drawn < 50) return;                // 3D: ~20 updates/s is plenty and keeps the scene smooth
    v.drawn = now;
    const cur = currentLevel(v.view, v.ff);
    carts.forEach((c) => {
      const o = v.gr[c.id];
      const geom = geomFor(v, c.x, c.y, c.l);
      const onFloor = !cur || LEVELS[c.l]?.id === cur;
      const show = opts.visible && (onFloor || !opts.floorsOnly);
      const a = onFloor ? 1 : 0.32;
      const t = tone(statusOf(c));
      const sel = opts.selected === c;
      o.dot.geometry = geom; o.label.geometry = geom; o.pulse.geometry = geom;
      o.dot.visible = o.label.visible = show; o.pulse.visible = show && (c.mode === "lost" || sel);
      const key = `${c.l}|${t}|${a}|${sel}|${c.lift ? c.lift.up : ""}|${c.mode}`;
      if (v.last[c.id] !== key) {
        v.last[c.id] = key;
        o.dot.symbol = symDot(v, t, a, sel);
        o.label.symbol = symLabel(v, c, t, a);
      }
      if (o.pulse.visible && (!v.is3d || now - o.pt > 70)) { o.pt = now; o.pulse.symbol = symPulse(v, c, (now / 900) % 1); }
    });
  }
  function drawRoute() {
    V.forEach((v) => v.routeLayer.removeAll());
    const v = act, c = opts.selected;
    if (!v || !opts.visible || !opts.routes || !c || !c.path) return;
    const cur = currentLevel(v.view, v.ff);
    const sr = merc(0, 0, v.view.spatialReference).spatialReference;
    const vert = (x, y, l) => { const m = merc(x, y, v.view.spatialReference); return v.is3d ? [m.x, m.y, zOf(l) + 0.35 + v.zShift] : [m.x, m.y]; };
    let run = [vert(c.x, c.y, c.l)], runL = c.l;
    const flush = () => {
      if (run.length < 2) return;
      const on = v.is3d || !cur || LEVELS[runL]?.id === cur;
      const color = on ? [212, 175, 55, 0.95] : [212, 175, 55, 0.3];
      v.routeLayer.add(new Graphic({
        geometry: { type: "polyline", paths: [run], hasZ: v.is3d, spatialReference: sr },
        symbol: v.is3d ? { type: "line-3d", symbolLayers: [{ type: "line", size: 3.5, material: { color }, pattern: { type: "style", style: "dash" } }] }
          : { type: "simple-line", style: "short-dash", width: on ? 3.5 : 2, color }
      }));
    };
    for (let i = c.seg + 1; i < c.path.length; i++) {
      const n = c.path[i];
      if (!v.is3d && g.l[n] !== runL) { flush(); run = [vert(g.x[n], g.y[n], g.l[n])]; runL = g.l[n]; }
      else run.push(vert(g.x[n], g.y[n], g.l[n]));     // 3D keeps one line: elevator rides show as vertical runs
    }
    flush();
    const d = c.goal;
    if (d) v.routeLayer.add(new Graphic({ geometry: geomFor(v, d.x, d.y, d.level, 0.2),
      symbol: v.is3d ? { type: "point-3d", verticalOffset: OFF3, callout: { type: "line", size: 1.5, color: [212, 175, 55, 1] },
        symbolLayers: [{ type: "icon", resource: { primitive: "kite" }, size: 16, material: { color: [212, 175, 55, 1] }, outline: { color: [11, 23, 48, 1], size: 1.5 } }] }
        : { type: "simple-marker", style: "diamond", size: 14, color: [212, 175, 55, 1], outline: { color: [11, 23, 48, 1], width: 2 } } }));
  }
  attach(view, floorFilterEl, false);

  // --------------------------------------------------------------------------- dashboard
  const idleShort = (c) => {
    if (c.parkedAt) return `${Math.max(0, Math.round((Date.now() - c.parkedAt) / 60000))}m`;
    const m = /since (\d+):(\d+) (AM|PM)/.exec(c.idle || "");
    if (!m) return "—";
    const now = new Date(), t = new Date(now);
    t.setHours((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0), Number(m[2]), 0, 0);
    if (t > now) t.setDate(t.getDate() - 1);
    return `${Math.floor((now - t) / 3600000)}h`;
  };
  const fmtEta = (s) => (s <= 0 ? "—" : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
  boardEl.innerHTML = `
    <div class="bd-controls">
      <div class="seg" id="spdSeg" title="Simulation speed">${[1, 5, 15].map((s) => `<button data-s="${s}" class="${s === opts.speed ? "on" : ""}">${s}×</button>`).join("")}</div>
      <div class="seg" id="flrSeg" title="Carts on other floors"><button data-f="all" class="on">All floors</button><button data-f="this">This floor</button></div>
      <label class="chk"><input type="checkbox" id="routeChk" checked> Route</label>
      <label class="chk"><input type="checkbox" id="followChk"> Follow</label>
    </div>
    <div class="ctable">
      <div class="crow chead"><span>Cart</span><span>Heading to</span><span>Floor</span><span>Signed out to</span><span>ETA</span></div>
      <div id="cartRows"></div>
    </div>
    <p class="fineprint">Simulated in this browser session (synthetic carts and attendants). Cancel / Reassign do not edit the hosted layer.
    Routes follow walkable corridors and freight elevators; FE-SW is avoided while in Alarm.</p>`;
  const rowsEl = boardEl.querySelector("#cartRows");
  carts.forEach((c) => {
    const r = document.createElement("div");
    r.className = "crow"; r.dataset.id = c.id;
    r.innerHTML = `
      <span class="badge-c"><b>${esc(c.id.replace("C-", ""))}</b><small>CART</small></span>
      <span class="c-to"><b></b><small></small></span>
      <span class="c-fl"><b></b><small></small></span>
      <span class="c-who"><b></b><small></small></span>
      <span class="c-eta"></span>
      <span class="c-act">
        <span class="c-st"></span>
        <button class="pbtn pb-cancel" data-menu="cancel">Cancel <span class="caret">▾</span></button>
        <button class="pbtn pb-reassign" data-menu="reassign">Reassign <span class="caret">▾</span></button>
      </span>
      <div class="c-more" hidden></div>`;
    c.row = r;
    rowsEl.appendChild(r);
  });
  function renderRows() {
    carts.forEach((c) => {
      const r = c.row, st = statusOf(c), t = tone(st);
      r.classList.toggle("sel", opts.selected === c);
      r.style.setProperty("--tone", TONE_HEX[t]);
      r.querySelector(".c-st").innerHTML = `<span class="pill t-${t}">${esc(st)}</span>`;
      const to = c.mode === "lost" ? `Found: ${c.room || LEVELS[c.l].name}` : c.goal ? c.goal.name : c.mode === "hold" ? "On hold" : "VIP Cart Staging";
      const sub = c.mode === "lost" ? (c.spot ? `${c.spot} · ${LEVELS[c.l].short}` : c.where || "") : c.goal ? (c.goal === hub ? "Event Level · restock" : `${c.goal.group || c.goal.kind} · ${LEVELS[c.goal.level].short}`) : "";
      r.querySelector(".c-to b").textContent = to; r.querySelector(".c-to small").textContent = sub;
      r.querySelector(".c-fl b").textContent = c.lift ? `${c.lift.up ? "▲" : "▼"} ${LEVELS[c.l].short}` : LEVELS[c.l].short;
      r.querySelector(".c-fl small").textContent = c.lift ? c.lift.name : LEVELS[c.l].name;
      r.querySelector(".c-who b").textContent = c.attendant || "Unassigned";
      r.querySelector(".c-who small").textContent = c.tag;
      c.eta = c.path ? remaining(c) : c.mode === "service" || c.mode === "stock" ? c.dwell : 0;
      r.querySelector(".c-eta").innerHTML = c.mode === "lost" ? `<span title="${esc(c.idle || "")} · ${esc(c.lastSeen || "")}"><small>idle</small>${esc(idleShort(c))}</span>` : c.path ? fmtEta(c.eta / opts.speed) : c.mode === "service" ? `<small>at stop</small>` : c.mode === "stock" ? `<small>at hub</small>` : "—";
      const more = r.querySelector(".c-more");
      if (!more.hidden) {
        more.innerHTML = `<div><b>Queue</b> ${c.queue.length ? c.queue.map((d) => esc(d.name)).join(" → ") : "—"}</div>
          <div><b>Order</b> ${esc(c.order || "—")} · <b>Served</b> ${c.served} · <b>Sales</b> $${Math.round(c.sales).toLocaleString()} · <b>Usual run</b> ${esc(c.assignment)}</div>`;
      }
    });
    const active = carts.filter((c) => ["travel", "back", "service"].includes(c.mode)).length;
    const lost = carts.filter((c) => c.mode === "lost").length;   // inactive (parked / hidden) carts
    const moving = carts.filter((c) => c.path && c.goal !== hub);
    const avgEta = moving.length ? moving.reduce((s, c) => s + c.eta, 0) / moving.length / opts.speed : 0;
    onKpi?.({ active, total: carts.length, lost, served: carts.reduce((s, c) => s + c.served, 0), sales: carts.reduce((s, c) => s + c.sales, 0), avgEta: fmtEta(avgEta) });
  }

  rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".pbtn");
    const row = e.target.closest(".crow");
    if (!row) return;
    const c = carts.find((x) => x.id === row.dataset.id);
    if (btn) { e.stopPropagation(); openMenu(btn, c, btn.dataset.menu); return; }
    select(c, true);
    const more = row.querySelector(".c-more"); more.hidden = !more.hidden; renderRows();
  });
  boardEl.querySelector("#spdSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    opts.speed = Number(b.dataset.s); boardEl.querySelectorAll("#spdSeg button").forEach((x) => x.classList.toggle("on", x === b));
  });
  boardEl.querySelector("#flrSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    opts.floorsOnly = b.dataset.f === "this"; boardEl.querySelectorAll("#flrSeg button").forEach((x) => x.classList.toggle("on", x === b)); resetSyms();
  });
  boardEl.querySelector("#routeChk").addEventListener("change", (e) => { opts.routes = e.target.checked; drawRoute(); });
  boardEl.querySelector("#followChk").addEventListener("change", (e) => { opts.follow = e.target.checked; if (opts.follow && opts.selected) focus(opts.selected); });

  async function focus(c) {
    const v = act, lid = LEVELS[c.l]?.id;
    if (currentLevel(v.view, v.ff) !== lid) setFloor(v.view, v.ff, lid);
    const target = geomFor(v, c.x, c.y, c.l);
    const zoom = Math.max(v.view.zoom || 0, 19);
    try { await v.view.goTo(v.is3d ? { target, zoom, tilt: 62 } : { target, zoom }, { duration: 700 }); } catch { /* interrupted */ }
  }
  function select(c, zoom) {
    opts.selected = opts.selected === c && !zoom ? null : c; resetSyms();
    renderRows(); drawRoute();
    if (c && zoom) focus(c);
  }

  // --------------------------------------------------------------------------- menus
  let menuEl = null;
  const closeMenu = () => { menuEl?.remove(); menuEl = null; document.querySelectorAll(".pbtn.open").forEach((b) => b.classList.remove("open")); };
  document.addEventListener("click", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  function item(icon, label, sub, fn, cls = "") {
    const b = document.createElement("button");
    b.className = "mi " + cls;
    b.innerHTML = `<calcite-icon icon="${icon}" scale="s"></calcite-icon><span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>`;
    b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); fn(); renderRows(); drawRoute(); });
    return b;
  }
  function openMenu(btn, c, kind) {
    const was = btn.classList.contains("open");
    closeMenu();
    if (was) return;
    btn.classList.add("open");
    menuEl = document.createElement("div");
    menuEl.className = `menu menu-${kind}`;
    menuEl.addEventListener("click", (e) => e.stopPropagation());
    const head = document.createElement("div");
    head.className = "menu-h";
    head.innerHTML = `<span>${kind === "cancel" ? "Cancel" : "Reassign"} · <b>${esc(c.id)}</b></span><small>${esc(statusOf(c))} · ${esc(LEVELS[c.l].name)}</small>`;
    menuEl.appendChild(head);
    if (kind === "cancel") buildCancel(c); else buildReassign(c);
    document.body.appendChild(menuEl);
    const r = btn.getBoundingClientRect(), mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    let left = Math.min(window.innerWidth - mw - 8, r.right - mw), top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menuEl.style.left = `${Math.max(8, left)}px`; menuEl.style.top = `${top}px`;
    menuEl.querySelector("input")?.focus();
  }
  function buildCancel(c) {
    const L = menuEl;
    if (c.mode === "lost") {
      L.appendChild(item("walking", "Send runner to retrieve", `Pick it up at ${c.room || LEVELS[c.l].name}`, () => onEvent?.(`Runner sent to retrieve ${c.id}: ${c.where || LEVELS[c.l].name}`, "purple")));
      L.appendChild(item("check-circle", "Retrieved · return to staging", "Put it back in rotation at VIP Cart Staging", () => { c.mode = "hold"; c.lost = null; routeTo(c, hub, "back"); onEvent?.(`${c.id} retrieved from ${c.room || LEVELS[c.l].name}, heading to staging`, "green"); }));
      return;
    }
    if (c.mode === "hold") L.appendChild(item("play", "Resume run", c.goal ? `Continue to ${c.goal.name}` : "Continue queue", () => resume(c)));
    L.appendChild(item("home", "Cancel run · return to staging", "Clear the queue and head to Event Level staging", () => {
      c.queue = []; routeTo(c, hub, "back"); onEvent?.(`${c.id} run cancelled, returning to staging`, "blue");
    }));
    if (c.goal && c.goal !== hub && c.mode !== "hold") L.appendChild(item("skip-forward", "Skip this stop", `Drop ${c.goal.name}, go to next`, () => {
      const skipped = c.goal.name; const next = c.queue.shift();
      if (next) routeTo(c, next, "travel"); else routeTo(c, hub, "back");
      onEvent?.(`${c.id} skipped ${skipped}`, "purple");
    }));
    if (c.mode !== "hold") L.appendChild(item("pause", "Hold in place", "Stop the cart where it is", () => { c.prevMode = c.mode; c.mode = "hold"; onEvent?.(`${c.id} on hold at ${LEVELS[c.l].name}`, "purple"); }));
    L.appendChild(item("stop", "Park · mark inactive", "Take it out of rotation where it is", () => {
      c.mode = "lost"; c.lost = "Inactive"; c.path = null; c.goal = null; c.lastSeen = "tag ping just now"; c.room = null; c.spot = "parked"; c.idle = "idle since just now"; c.parkedAt = Date.now();
      onEvent?.(`${c.id} parked and marked inactive on ${LEVELS[c.l].name}`, "purple");
    }, "danger"));
  }
  function resume(c) {
    const mode = c.prevMode || "travel";
    if (c.goal) routeTo(c, c.goal, c.goal === hub ? "back" : mode === "back" ? "back" : "travel");
    else { const n = c.queue.shift(); if (n) routeTo(c, n, "travel"); else routeTo(c, hub, "back"); }
    onEvent?.(`${c.id} resumed`, "green");
  }
  function buildReassign(c) {
    const tabs = document.createElement("div");
    tabs.className = "menu-tabs";
    tabs.innerHTML = `<button class="on" data-t="dest">Destination</button><button data-t="who">Signed out to</button>`;
    menuEl.appendChild(tabs);
    const search = document.createElement("input");
    search.className = "menu-search"; search.placeholder = "Search suites, club seats, lounges…";
    menuEl.appendChild(search);
    const list = document.createElement("div");
    list.className = "menu-list";
    menuEl.appendChild(list);
    const go = (d) => {
      if (c.mode === "lost") { c.lost = null; c.mode = "hold"; }
      c.queue = []; c.plan = [d];
      if (routeTo(c, d, "travel")) {
        const secs = remaining(c);
        onEvent?.(`${c.id} reassigned to ${d.name} (${LEVELS[d.level].name}), ETA ${fmtEta(secs / opts.speed)}`, "green");
        if (opts.selected !== c) select(c, false);
      }
    };
    const renderDest = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = "";
      const groups = {};
      [...dests, hub].filter((d) => !q || `${d.name} ${d.group} ${d.kind} ${LEVELS[d.level].name}`.toLowerCase().includes(q))
        .forEach((d) => (groups[d === hub ? "Staging" : d.group || d.kind] ||= []).push(d));
      Object.entries(groups).forEach(([gname, ds]) => {
        const h = document.createElement("div"); h.className = "mg"; h.textContent = `${gname} · ${LEVELS[ds[0].level].short}`; list.appendChild(h);
        ds.forEach((d) => {
          const cur = c.goal === d;
          list.appendChild(item(d === hub ? "home" : d.kind === "Suite" ? "door" : d.kind === "Lounge" ? "organization" : "group",
            d.name, `${LEVELS[d.level].name}${cur ? " · current destination" : ""}`, () => go(d), cur ? "cur" : ""));
        });
      });
      if (!list.children.length) list.innerHTML = `<div class="mg">No match</div>`;
    };
    const renderWho = () => {
      list.innerHTML = "";
      attendants.forEach((n) => {
        const holder = carts.find((x) => x.attendant === n && x !== c);
        list.appendChild(item("user", n, holder ? `currently on ${holder.id} (will swap)` : c.attendant === n ? "current" : "available", () => {
          if (holder) holder.attendant = c.attendant;
          c.attendant = n; onEvent?.(`${c.id} signed out to ${n}${holder ? ` (${holder.id} now ${holder.attendant || "unassigned"})` : ""}`, "blue");
        }, c.attendant === n ? "cur" : ""));
      });
      list.appendChild(item("user-x", "Unassign", "Cart parked with no attendant", () => { c.attendant = ""; c.queue = []; routeTo(c, hub, "back"); onEvent?.(`${c.id} unassigned, returning to staging`, "purple"); }, "danger"));
    };
    let tab = "dest";
    tabs.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      tab = b.dataset.t; tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      search.hidden = tab !== "dest"; tab === "dest" ? renderDest() : renderWho();
    });
    search.addEventListener("input", renderDest);
    renderDest();
  }

  // --------------------------------------------------------------------------- loop
  let last = performance.now(), acc = 0, accRoute = 0, followT = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    carts.forEach((c) => step(c, dt * opts.speed));
    draw(now);
    acc += dt; accRoute += dt; followT += dt;
    if (acc > 0.5) { acc = 0; renderRows(); }
    if (accRoute > 1) { accRoute = 0; drawRoute(); }
    if (opts.follow && opts.selected && followT > 1.5) {
      followT = 0;
      const c = opts.selected, v = act;
      if (currentLevel(v.view, v.ff) !== LEVELS[c.l]?.id) setFloor(v.view, v.ff, LEVELS[c.l].id);
      v.view.goTo({ target: geomFor(v, c.x, c.y, c.l) }, { duration: 900 }).catch(() => {});
    }
    requestAnimationFrame(frame);
  }
  carts.filter((c) => c.mode === "lost").forEach((c) =>
    onEvent?.(`${c.id} inactive, located by its tag: ${c.room} (${c.spot}), ${LEVELS[c.l].name}, ${c.idle}`, "purple"));
  renderRows();
  requestAnimationFrame(frame);

  return {
    carts, hub, dests,
    setVisible(on) { opts.visible = on; V.forEach((v) => { v.layer.visible = on; v.routeLayer.visible = on; }); if (!on) closeMenu(); resetSyms(); drawRoute(); },
    attach: (view, ff, is3d, zShift) => { attach(view, ff, is3d, zShift); },
    setActive(view) { act = V.find((v) => v.view === view) || act; resetSyms(); drawRoute(); },
    select: (id) => select(carts.find((c) => c.id === id), true),
    reset() {                                   // clear selection / follow / menus (the simulation keeps running)
      closeMenu(); opts.selected = null; opts.follow = false;
      const f = boardEl.querySelector("#followChk"); if (f) f.checked = false;
      boardEl.querySelectorAll(".c-more").forEach((m) => (m.hidden = true));
      resetSyms(); renderRows(); drawRoute();
    },
    _test: { g, dijkstra, routeTo, remaining, opts, step }
  };
}
