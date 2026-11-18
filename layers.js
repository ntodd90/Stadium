// =====================================================================================
// Gillette Stadium Game-Day Ops – shared helpers
// Layer classification (by FIELDS, so renamed or grouped layers still work), level names,
// status tones, floor switching. Unit-tested in node against the GDB schema.
// =====================================================================================

export const FACILITY = "GIL.B1";
export const LEVELS = {
  0: { id: "GIL.B1.L0", name: "Event Level", short: "EV", tag: "EVENT LVL" },
  1: { id: "GIL.B1.L1", name: "Main Concourse", short: "MC", tag: "MAIN CONCOURSE" },
  2: { id: "GIL.B1.L2", name: "Club Level", short: "CL", tag: "CLUB LVL" },
  3: { id: "GIL.B1.L3", name: "Suite Level 1", short: "S1", tag: "SUITE LVL 1" },
  4: { id: "GIL.B1.L4", name: "Suite Level 2", short: "S2", tag: "SUITE LVL 2" },
  5: { id: "GIL.B1.L5", name: "Upper Concourse", short: "UC", tag: "UPPER CONCOURSE" },
  6: { id: "GIL.B1.L6", name: "Lighthouse Deck", short: "LH", tag: "LIGHTHOUSE" }
};
export const levelNum = (lid) => {
  const m = /\.L(\d+)$/.exec(String(lid || ""));
  return m ? Number(m[1]) : null;
};
export const levelName = (lid) => LEVELS[levelNum(lid)]?.name || "";

// One palette everywhere (map symbology, pop-ups, app). Hosted layers also carry STATUS_TONE.
export const TONE_HEX = { green: "#2E8B57", blue: "#2F6DB5", purple: "#6E4FA3", red: "#C8102E", muted: "#7B8494" };
const TONES = {
  green: ["Online", "Running", "Clear", "Covered", "On Post", "Open", "Active", "Servicing", "En Route", "Resolved", "OK", "Normal"],
  blue: ["Stocking", "Returning", "Patrolling", "Filling", "Busy", "Cleaning", "Idle", "Active - Reroute", "Charging", "In Progress"],
  purple: ["Inactive", "PM Due", "Inspection Due", "Responding", "Short-staffed", "Nearly Full", "Holding", "Break", "Degraded", "Sold Out - Item", "P2 - Compliance"],
  red: ["Offline", "Down", "Alarm", "Blocked", "Uncovered", "New", "Lost Signal", "Unaccounted", "Obstructed", "Closed - Maintenance",
    "Do Not Use - Exit Blocked", "Full", "Closed", "P1 - Emergency"]
};
export function tone(status, hint) {
  if (hint && TONE_HEX[hint]) return hint;
  for (const [t, list] of Object.entries(TONES)) if (list.includes(status)) return t;
  return "muted";
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pill = (status, text, hint) => `<span class="pill t-${tone(status, hint)}">${esc(text ?? status)}</span>`;

// Layer categories, detected from each layer's fields (order matters).
export const RULES = [
  ["carts", (f) => f.has("CART_ID") && f.has("BATTERY_PCT")],
  ["cartTrips", (f) => f.has("CART_ID") && f.has("LEG_SEQ")],
  ["cartDeliveries", (f) => f.has("ORDER_ID") && f.has("DELIVER_TO")],
  ["cartReaders", (f) => f.has("READER_ID")],
  ["cameras", (f) => f.has("CAMERA_ID") && f.has("HEADING_DEG")],
  ["coverage", (f) => f.has("CAMERA_ID")],
  ["guards", (f) => f.has("GUARD_ID") && f.has("CALLSIGN")],
  ["guardTracks", (f) => f.has("GUARD_ID") && f.has("MINUTES")],
  ["posts", (f) => f.has("POST_TYPE") && f.has("STAFF_REQUIRED")],
  ["incidents", (f) => f.has("INCIDENT_ID")],
  ["exits", (f) => f.has("EXIT_TYPE") && f.has("FLOW_CAPACITY_PPM")],
  ["egress", (f) => f.has("ROUTE_ROLE")],
  ["workorders", (f) => f.has("WORK_ORDER") && f.has("PRIORITY")],
  ["equip", (f) => f.has("ASSET_ID") && f.has("DEMO_WORK_ORDER")],
  ["stands", (f) => f.has("STAND_ID")],
  ["restrooms", (f) => f.has("RESTROOM_ID")],
  ["doors", (f) => f.has("DOOR_ID")],
  ["seats", (f) => f.has("SEAT_ID")],
  ["rows", (f) => f.has("TREAD_Z_NAVD88")],
  ["sections", (f) => f.has("SECTION") && f.has("ROW_COUNT")],
  ["siteCams", (f) => f.has("CAMERA_TYPE") && f.has("SITE_ID")],
  ["siteAssets", (f) => f.has("ASSET_TYPE") && f.has("SITE_ID")],
  ["zones", (f) => f.has("ZONE_TYPE")],
  ["lanes", (f) => f.has("LANE_TYPE")],
  ["details", (f) => f.has("DETAIL_ID")],
  ["units", (f) => f.has("UNIT_ID")],
  ["levels", (f) => f.has("LEVEL_NUMBER") && f.has("LEVEL_ID")],
  ["facilities", (f) => f.has("FACILITY_ID") && f.has("SITE_ID")],
  ["sites", (f) => f.has("SITE_ID")]
];
export function classifyFields(names) {
  const f = new Set((names || []).map((x) => String(x).toUpperCase()));
  const hit = RULES.find(([, test]) => test(f));
  return hit ? hit[0] : "other";
}
export const classify = (layer) => classifyFields((layer.fields || []).map((x) => x.name));

// Switch the floor filter (component + view) to a level ID, or clear it with null.
export function setFloor(view, floorFilterEl, levelId) {
  try {
    if (floorFilterEl) {
      floorFilterEl.facility = levelId ? FACILITY : null;
      floorFilterEl.level = levelId || null;
    }
    if (view?.floors) {
      view.floors.removeAll();
      if (levelId) view.floors.add(levelId);
    }
  } catch (e) {
    console.warn("[floor]", e);
  }
}
// Level currently shown (floor filter first, then view.floors).
export function currentLevel(view, floorFilterEl) {
  const l = floorFilterEl?.level || (view?.floors?.length ? view.floors.getItemAt(0) : null);
  return l || null;
}

// Point to show a popup at: points as-is, polygons/lines at their extent centre.
export const anchor = (g) => (g?.type === "point" ? g : g?.centroid || g?.extent?.center || g);
