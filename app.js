/* CoMo Food Radar: searches every kind of public city record for signs of a restaurant or food business on the way. */
const RELAY = window.RADAR_RELAY;
const GIS = "https://gis.gocolumbiamo.com/arcgis/rest/services";
const PARCELS = `${GIS}/Energov/Energov_View/MapServer/0`;
const ZONING = `${GIS}/View_Services/Zoning_Current/MapServer/0`;
const PLANNING = `${GIS}/CurrentPlanningCases/MapServer/0`;
const LIQUOR = "https://data.mo.gov/resource/d9fr-pncw.json";
const PAGE_SIZE = 100;
const DEFAULT_WORDS = "restaurant food cafe coffee bakery brewery pizza taco bbq sushi diner bistro eatery tavern pub grill catering grease";
const ENTITY = /\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|PARTNERS|PARTNERSHIP|PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|DEVELOPMENT|REALTY|GROUP|BANK|CHURCH|UNIVERSITY|CITY OF|COUNTY|SCHOOL|DISTRICT|ASSOCIATION|ASSN|FOUNDATION|CURATORS|STATE OF|HOSPITAL|PLAZA|CENTER|MALL|TRUST CO)\b/i;
const LOCAL = new Set(["COLUMBIA", "COL"]);
// Record types that are about food on their own, whatever the description says.
const FOOD_TYPE = /Food Establishment|Caterer|Accommodation and Food|Food Services|Sidewalk Cafe|Liquor License|Restaurant|Drinking Places|Food Truck|Mobile Food|Grease/i;
const STAGES = [
  { key: "planning", label: "Planning", color: "#7e22ce" },
  { key: "construction", label: "Construction", color: "#b45309" },
  { key: "licensing", label: "Licensing", color: "#1d4ed8" },
  { key: "inspections", label: "Inspections", color: "#0e7490" },
  { key: "signage", label: "Signage", color: "#15803d" },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

/* ---------------------------------------------------------------- helpers */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const KEEP_UPPER = /^(LLC|LLP|LP|INC|CO|PC|PLLC|DBA|USA|US|MO|II|III|IV|BBQ|ATM|HVAC|NE|NW|SE|SW|N|S|E|W|[A-Z]-\d+)$/;
const titleCase = (s) => (s && s === s.toUpperCase()
  ? s.toLowerCase().replace(/[a-z0-9][a-z0-9'.&-]*/g, (w) => (KEEP_UPPER.test(w.toUpperCase().replace(/[.,]$/, "")) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
  : s);
const fmtAddr = (s) => (s || "").replace(/\b[A-Z][A-Z'&.-]+\b/g, (w) => (KEEP_UPPER.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const normName = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\b(LLC|INC|CORP|CO|THE|L L C|DBA)\b/g, " ").replace(/\s+/g, " ").trim();
const KEYWORD_RE = /^[\w &'.,#/-]{2,60}$/;
const streetOnly = (a) => (a || "").replace(/\s+(COLUMBIA|COL)\s+MO\b.*$/i, "").replace(/\s+(STE|APT|UNIT|SUITE|BLDG|#)\b.*$/i, "").trim();
const unitOf = (a) => ((a || "").match(/\b(STE|APT|UNIT|SUITE)\s+([A-Z0-9-]+)/i) || [])[2]?.toUpperCase() || "";
const words = () => ($("words").value || "").toLowerCase().split(/[\s,]+/).map((w) => w.trim()).filter((w) => /^[a-z0-9&'-]{3,30}$/.test(w)).slice(0, 30);
const wordRe = () => new RegExp(`\\b(${words().map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join("|") || "restaurant"})\\w*`, "i");
const ext = (href, label) => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `${r.status} from ${new URL(url, location.href).host}`);
  return d;
}
const gisQuery = (layer, params) => getJSON(`${layer}/query`, { method: "POST", body: new URLSearchParams({ f: "json", ...params }) });

/* ---------------------------------------------------------------- session log (shown on Data sources) */
const log = { feeds: {}, notFood: 0, related: { lookups: 0, records: 0, excluded: {} }, owners: { lookups: 0, parcels: 0 }, planning: { read: 0 }, parcels: 0, liquor: 0 };
const addExcluded = (t, ex) => { for (const [k, n] of Object.entries(ex || {})) t[k] = (t[k] || 0) + n; };

/* ---------------------------------------------------------------- live feeds */
class Feed {
  constructor(kind, keyword, exact = false) {
    Object.assign(this, { kind, keyword, exact, rows: [], page: 0, oldest: null, newest: null, done: false });
    this.label = `${kind}${exact ? ` "${keyword}"` : " matching food words"}`;
    log.feeds[this.label] = log.feeds[this.label] || { pages: 0, read: 0, kept: 0, excluded: {} };
  }
  covers(cutoff) { return this.done || (this.oldest && new Date(this.oldest) < cutoff); }
  fetchPage(p) {
    const q = new URLSearchParams({ kind: this.kind, keyword: this.keyword, page: p, size: PAGE_SIZE });
    if (this.exact) q.set("exact", "1");
    return getJSON(`${RELAY}/search?${q}`);
  }
  take(d, onPage) {
    this.page = Math.max(this.page, d.page);
    if (d.oldest && (!this.oldest || d.oldest < this.oldest)) this.oldest = d.oldest;
    if (!d.has_more) this.done = true;
    this.rows.push(...d.rows);
    const l = log.feeds[this.label]; l.pages++; l.read += d.read; l.kept += d.rows.length; addExcluded(l.excluded, d.excluded);
    return onPage(d.rows);
  }
  // City pages take ~6s each: after the first page, estimate how many more the window needs and fetch 3 at a time.
  async extend(cutoff, onPage, token) {
    if (this.covers(cutoff)) return;
    if (this.page === 0) {
      const first = await this.fetchPage(1);
      if (token.cancelled) return;
      this.newest = first.rows[0]?.applied || new Date().toISOString();
      await this.take(first, onPage);
    }
    while (!this.covers(cutoff) && !token.cancelled) {
      const span = (new Date(this.newest) - new Date(this.oldest)) / this.page || 864e5;
      const need = Math.ceil((new Date(this.oldest) - cutoff) / span);
      const batch = Array.from({ length: Math.min(Math.max(need, 1), 3) }, (_, i) => this.page + 1 + i);
      const results = await Promise.all(batch.map((p) => this.fetchPage(p)));
      if (token.cancelled) return;
      for (const d of results.sort((a, b) => a.page - b.page)) await this.take(d, onPage);
    }
  }
}
const feeds = new Map();
function feed(kind, keyword, exact = false) {
  const k = `${kind}|${keyword}|${exact}`;
  if (!feeds.has(k)) feeds.set(k, new Feed(kind, keyword, exact));
  return feeds.get(k);
}
const allFeeds = () => {
  const w = words().join(" ") || "restaurant";
  return [feed("permits", w), feed("plans", w), feed("licenses", w),
    feed("inspections", "Food Establishment", true), feed("inspections", "NEW Business", true)];
};

/* ---------------------------------------------------------------- enrichment */
const parcels = new Map();
async function enrich(rows) {
  const todo = [...new Set(rows.map((r) => r.parcel).filter((p) => p && !parcels.has(p)))];
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    chunk.forEach((p) => parcels.set(p, null));
    try {
      const res = await gisQuery(PARCELS, { where: `PARCEL IN (${chunk.map((p) => `'${p}'`).join(",")})`, outFields: "PARCEL,OWNER1",
        returnGeometry: "true", outSR: "4326", maxAllowableOffset: "0.00005" });
      for (const f of res.features || []) {
        const pts = (f.geometry?.rings || []).flat();
        const raw = f.attributes.OWNER1 || "";
        const owner = raw.replace(/\s+/g, " ").replace(/\s*&\s*$/, "").trim();
        parcels.set(f.attributes.PARCEL, {
          lat: pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null,
          lng: pts.length ? pts.reduce((s, p) => s + p[0], 0) / pts.length : null,
          owner: ENTITY.test(owner) ? owner : null, ownerRaw: ENTITY.test(owner) ? raw.trim() : null, zoning: null,
        });
        log.parcels++;
      }
    } catch (e) { console.warn("parcel lookup failed", e); }
  }
  const needZoning = todo.map((p) => parcels.get(p)).filter((v) => v && v.lat != null && v.zoning == null);
  for (let i = 0; i < needZoning.length; i += 8) {
    await Promise.all(needZoning.slice(i, i + 8).map(async (v) => {
      try {
        const res = await gisQuery(ZONING, { geometry: `${v.lng},${v.lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
          spatialRel: "esriSpatialRelIntersects", outFields: "DISTRICT", returnGeometry: "false" });
        v.zoning = (res.features?.[0]?.attributes?.DISTRICT || "").trim();
      } catch { v.zoning = ""; }
      v.residential = /^R-|^R\d|^RMH|^PUD/i.test(v.zoning || "");
    }));
  }
}

let liquor = null;
async function loadLiquor() {
  if (liquor) return;
  const q = new URLSearchParams({ $where: "upper(city) like '%COLUMBIA%' AND upper(county) like '%BOONE%'", $limit: "5000", $select: "licensee,dbaname,primary_type" });
  try {
    const rows = await getJSON(`${LIQUOR}?${q}`);
    log.liquor = rows.length;
    liquor = new Map();
    for (const r of rows) for (const k of [r.dbaname, r.licensee]) if (normName(k) && !liquor.has(normName(k))) liquor.set(normName(k), r);
  } catch { liquor = new Map(); }
}

let planning = null;
async function loadPlanning() {
  if (planning) return;
  const since = new Date(Date.now() - 365 * 864e5);
  const yymmdd = `${String(since.getFullYear()).slice(2)}${String(since.getMonth() + 1).padStart(2, "0")}${String(since.getDate()).padStart(2, "0")}`;
  const like = (words().length ? words() : ["restaurant"]).map((w) => `UPPER(ext_desc) LIKE '%${w.toUpperCase().replace(/'/g, "''")}%'`).join(" OR ");
  try {
    const res = await gisQuery(PLANNING, { where: `cent = 1 AND app_dat >= ${yymmdd} AND (${like})`, outFields: "PZ_OPTVW,ext_desc,typ_code,app_dat,Link",
      returnGeometry: "true", outSR: "4326", maxAllowableOffset: "0.0001" });
    planning = (res.features || []).map((f) => {
      const a = f.attributes; const d = String(a.app_dat || ""); const pts = (f.geometry?.rings || []).flat();
      return { kind: "case", id: a.PZ_OPTVW, type: "Planning case", description: a.ext_desc, link: a.Link,
        applied: d.length === 6 ? `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}T12:00:00` : null,
        lat: pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null, lng: pts.length ? pts.reduce((s, p) => s + p[0], 0) / pts.length : null };
    });
    log.planning.read = planning.length;
  } catch { planning = []; }
}

/* ---------------------------------------------------------------- classify and group */
function stageOf(r) {
  if (r.kind === "case" || r.kind === "plan") return "planning";
  if (r.kind === "license") return "licensing";
  if (r.kind === "inspection") return "inspections";
  if (/^Sign$/i.test(r.type || "")) return "signage";
  return "construction";
}
function isFood(r, re) {
  const typeText = `${r.type || ""} ${r.license_type || ""} ${r.industry || ""}`;
  if (FOOD_TYPE.test(typeText)) return true;
  // A license with a non-food industry only counts if its name is food-related (not a passing mention in the description).
  if (r.kind === "license" && r.industry) return re.test(`${r.dba || ""} ${r.company || ""}`);
  return re.test(`${r.description || ""} ${r.project || ""} ${r.dba || ""} ${r.company || ""}`);
}
function nameFor(list) {
  const lic = list.find((r) => r.kind === "license" && (r.dba || r.company));
  if (lic) return titleCase(lic.dba || lic.company);
  for (const r of list) {
    const m = (r.description || "").match(/\b(?:sign|signs|signage|wall|monument)\b.*?\bfor\s+([^.,;]{2,50})/i) || (r.description || "").match(/\(([A-Z][^)]{1,40})\)/);
    if (m) return m[1].trim();
  }
  const proj = list.find((r) => r.project);
  return proj ? titleCase(proj.project) : null;
}
// Group food records into places: one per parcel + unit (or street + unit), plus mobile/out-of-town businesses by name.
function places() {
  const since = cutoff();
  const re = wordRe();
  const recs = new Map();
  for (const f of allFeeds()) for (const r of f.rows) if (!recs.has(r.id)) recs.set(r.id, r);
  for (const r of planning || []) recs.set(r.id, r);
  const groups = new Map();
  let notFood = 0;
  for (const r of recs.values()) {
    if (!r.applied || new Date(r.applied) < since) continue;
    r.food = isFood(r, re);
    if (!r.food && r.kind !== "inspection") { notFood++; continue; }
    const p = r.parcel ? parcels.get(r.parcel) : null;
    if (r.kind === "license" && (r.home_based || p?.residential)) { r.private = true; }
    const local = r.kind !== "license" || LOCAL.has((r.city || "").toUpperCase());
    const key = r.kind === "case" ? `case:${r.id}`
      : !local || r.private ? `name:${normName(r.dba || r.company)}`
      : `${r.parcel || streetOnly(r.address).toUpperCase()}|${unitOf(r.address)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  log.notFood = notFood;
  const out = [];
  for (const [key, list] of groups) {
    if (!list.some((r) => r.food)) continue; // e.g. a "new business" fire inspection with no food evidence
    list.sort((a, b) => (b.applied || "").localeCompare(a.applied || ""));
    const lic = list.filter((r) => r.kind === "license");
    lic.forEach((r) => { const o = r.company_opened ? new Date(r.company_opened) : null; r.likely_new = !o || o >= new Date(new Date(r.applied) - 120 * 864e5); });
    const stagesSeen = new Set(list.map(stageOf));
    const routine = list.every((r) => r.kind === "inspection" || (r.kind === "license" && !r.likely_new));
    const withAddr = list.find((r) => r.address && !r.private && r.kind !== "case");
    const parcel = list.find((r) => r.parcel && !r.private)?.parcel;
    const p = parcel ? parcels.get(parcel) : null;
    const first = list[0];
    const mobile = key.startsWith("name:");
    const place = {
      key, list, routine, mobile, parcel, stagesSeen,
      stage: STAGES[Math.max(...[...stagesSeen].map((s) => STAGE_INDEX[s]))].key,
      name: nameFor(list) || (first.kind === "case" ? titleCase(first.description) : null),
      address: mobile ? null : withAddr?.address || null,
      city: lic[0]?.city, private: list.some((r) => r.private),
      applied: first.applied,
      lat: first.kind === "case" ? first.lat : p?.lat ?? null, lng: first.kind === "case" ? first.lng : p?.lng ?? null,
      owner: p?.owner || null, ownerRaw: p?.ownerRaw || null, zoning: p?.zoning || null,
      liquor: liquor && lic.map((r) => liquor.get(normName(r.dba)) || liquor.get(normName(r.company))).find(Boolean),
    };
    if (mobile) place.lat = place.lng = null;
    out.push(place);
  }
  return out;
}

/* ---------------------------------------------------------------- UI state */
const state = { token: { cancelled: true }, markers: new Map(), status: "", loading: false, tab: "radar" };
$("words").value = store.get("food-words") || DEFAULT_WORDS;
const map = L.map("map", { scrollWheelZoom: false }).setView([38.9517, -92.3341], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(map);
const layer = L.layerGroup().addTo(map);
const pin = (c) => L.divIcon({ className: "", html: `<div class="pin" style="background:${c}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
const cutoff = () => new Date(Date.now() - Number($("days").value) * 864e5);
$("legend").innerHTML = STAGES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");

function currentPlaces() {
  const q = $("q").value.trim().toLowerCase();
  const stage = $("stage").value;
  let list = places();
  if (!$("showRoutine").checked) list = list.filter((p) => !p.routine);
  if (stage) list = list.filter((p) => (stage === "mobile" ? p.mobile : p.stage === stage && !p.mobile));
  if (q) list = list.filter((p) => JSON.stringify({ n: p.name, a: p.address, o: p.owner, l: p.list }).toLowerCase().includes(q));
  return list.sort((a, b) => (b.applied || "").localeCompare(a.applied || ""));
}
function setStageCounts(all) {
  const keep = $("stage").value;
  const visible = $("showRoutine").checked ? all : all.filter((p) => !p.routine);
  const n = (f) => visible.filter(f).length;
  $("stage").innerHTML = `<option value="">All stages (${visible.length})</option>` +
    STAGES.map((s) => `<option value="${s.key}">Furthest along: ${s.label} (${n((p) => p.stage === s.key && !p.mobile)})</option>`).join("") +
    `<option value="mobile">Food trucks, caterers and out-of-town (${n((p) => p.mobile)})</option>`;
  $("stage").value = keep;
}

/* ---------------------------------------------------------------- cards */
function tracker(p) {
  return `<ol class="tracker">${STAGES.map((s) => `<li class="${p.stagesSeen.has(s.key) ? "on" : ""}${p.stage === s.key ? " now" : ""}" style="--c:${s.color}">${s.label}</li>`).join("")}</ol>`;
}
function signal(r) {
  const what = r.kind === "license" ? titleCase(r.dba || r.company || "") + (r.description ? ` · ${r.description}` : "") : r.description || "";
  const kind = { permit: "Permit", plan: "Plan", license: "License", inspection: "Inspection", case: "Planning case" }[r.kind];
  return `<li><span class="when">${fmtDate(r.applied)}</span> <strong>${kind}: ${esc(r.type)}</strong>${r.status ? ` · ${esc(r.status)}` : ""}${r.likely_new === false ? " · renewal" : ""}${what ? `<br><span class="what">${esc(what.slice(0, 200))}</span>` : ""}${r.link ? `<br>${ext(r.link.replace(/^http:/, "https:"), "Application (PDF)")}` : ""}</li>`;
}
function placeCard(p, uid) {
  const title = p.name || fmtAddr(streetOnly(p.address)) || "Unnamed place";
  const where = p.mobile ? (p.private ? "Home-based or residential address, not shown" : `Based in ${esc(titleCase(p.city) || "another town")}`)
    : p.address ? esc(fmtAddr(p.address)) : "Location in planning case";
  const street = !p.mobile && p.address ? streetOnly(p.address) : "";
  const lic = p.list.find((r) => r.kind === "license");
  const name = lic ? (lic.dba || lic.company || "").slice(0, 60) : "";
  const sv = p.lat != null && !p.private ? ext(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`, "Street View") : "";
  const gm = p.address && !p.mobile ? ext(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`, "Google Maps") : "";
  const canDrill = (street && KEYWORD_RE.test(street)) || (name && KEYWORD_RE.test(name)) || p.ownerRaw;
  const shown = p.list.slice(0, 5);
  return `
    <h3>${esc(title)}</h3>
    <p class="legal">${where}${p.zoning && !p.mobile ? ` · zoned ${esc(p.zoning)}` : ""}</p>
    ${p.mobile ? "" : tracker(p)}
    <div class="tags">
      ${p.routine ? '<span class="tag">Existing place: routine activity</span>' : '<span class="tag new">Something new</span>'}
      ${p.mobile ? '<span class="tag away">Mobile, catering or out-of-town</span>' : ""}
      ${p.liquor ? `<span class="tag">Liquor license: ${esc(p.liquor.primary_type)}</span>` : ""}
    </div>
    <ul class="signals">${shown.map(signal).join("")}</ul>
    ${p.list.length > shown.length ? `<p class="more">+${p.list.length - shown.length} more food-related records here</p>` : ""}
    ${p.owner ? `<dl class="facts"><dt>Property owner</dt><dd>${esc(titleCase(p.owner))}</dd></dl>` : ""}
    <div class="links">
      ${canDrill ? `<button class="drill" data-uid="${uid}" data-street="${esc(street && KEYWORD_RE.test(street) ? street : "")}" data-unit="${esc(unitOf(p.address))}" data-name="${esc(name && KEYWORD_RE.test(name) ? name : "")}" data-owner="${esc(p.ownerRaw || "")}" data-parcel="${esc(p.parcel || "")}" aria-expanded="false">Related records</button>` : ""}
      ${sv}${gm}
    </div>
    <div class="related" hidden></div>`;
}

/* ---------------------------------------------------------------- drill-down */
const RELATED_MODULES = [["permits", "Permits"], ["plans", "Plans"], ["licenses", "Business licenses"], ["inspections", "Inspections"], ["codecases", "Code cases"]];
const relatedCache = new Map();
function related(q, module, size = 25) {
  const k = `${q.toUpperCase()}|${module}|${size}`;
  if (!relatedCache.has(k)) {
    relatedCache.set(k, getJSON(`${RELAY}/related?${new URLSearchParams({ q, module, size })}`).then((d) => {
      log.related.lookups++; log.related.records += d.rows.length; addExcluded(log.related.excluded, d.excluded); return d;
    }).catch((e) => { relatedCache.delete(k); throw e; }));
  }
  return relatedCache.get(k);
}
function relatedRow(r) {
  const what = r.kind === "license" ? titleCase(r.dba || r.company || "") : r.description || "";
  const unit = (r.address || "").match(/\b(STE|APT|Unit)\s+\S+/i)?.[0] || "";
  return `<li data-unit="${esc(unitOf(r.address))}" class="${isFood(r, wordRe()) ? "foodrow" : ""}"><span class="when">${fmtDate(r.applied)}</span> <strong>${esc(r.type)}</strong>${r.status ? ` · ${esc(r.status)}` : ""}${unit ? ` · ${esc(fmtAddr(unit))}` : ""}${what ? `<br><span class="what">${esc(what.slice(0, 160))}</span>` : ""}</li>`;
}
async function moduleBlock(el, q, m, label, unit) {
  try {
    const d = await related(q, m);
    const rows = [...d.rows].sort((a, b) => (b.applied || "").localeCompare(a.applied || ""));
    const left = Object.values(d.excluded || {}).reduce((a, b) => a + b, 0);
    const more = d.total > d.read ? ` · newest ${d.read} of ${d.total}` : "";
    el.innerHTML = `<p class="relhead">${label} <span>${rows.length}${more}${left ? ` · ${left} left out` : ""}</span></p>` + (rows.length ? `<ul>${rows.map(relatedRow).join("")}</ul>` : "");
    if (unit) el.querySelectorAll("li").forEach((li) => li.classList.toggle("other-unit", li.dataset.unit !== unit));
  } catch (e) { el.innerHTML = `<p class="relhead">${label} <span>couldn't load (${esc(e.message)})</span></p>`; }
}
// Same owner: find the owner's other parcels in the county data, then each one's filings from the last year.
async function ownerBlock(el, ownerRaw, parcel) {
  try {
    log.owners.lookups++;
    const res = await gisQuery(PARCELS, { where: `OWNER1 LIKE '${ownerRaw.trim().replace(/'/g, "''").replace(/[%_]/g, "")}%'`, outFields: "PARCEL,ADDNUM,STNAME", returnGeometry: "false", resultRecordCount: "40" });
    const others = (res.features || []).map((f) => f.attributes).filter((a) => a.PARCEL !== parcel);
    log.owners.parcels += others.length;
    if (!others.length) { el.innerHTML = `<p class="relhead">Other properties <span>none: this is the owner's only parcel in the county data</span></p>`; return; }
    const shown = others.slice(0, 8);
    el.innerHTML = `<p class="relhead">Other properties <span>${others.length}${others.length > shown.length ? ` · checking the first ${shown.length}` : ""} · filings from the last 12 months</span></p><ul class="owner-props">${
      shown.map((a, i) => `<li id="${el.id}-p${i}"><strong>${esc(fmtAddr(`${(a.ADDNUM || "").trim()} ${(a.STNAME || "").trim()}`.trim()) || a.PARCEL)}</strong> <span class="what">asking the city…</span></li>`).join("")}</ul>`;
    const yearAgo = new Date(Date.now() - 365 * 864e5);
    shown.forEach(async (a, i) => {
      const li = document.getElementById(`${el.id}-p${i}`);
      try {
        const results = await Promise.all(["permits", "plans", "licenses"].map((m) => related(a.PARCEL, m, 15)));
        const rows = results.flatMap((d) => d.rows).filter((r) => r.applied && new Date(r.applied) >= yearAgo).sort((x, y) => (y.applied || "").localeCompare(x.applied || ""));
        li.querySelector(".what").textContent = rows.length ? `${rows.length} recent filing${rows.length === 1 ? "" : "s"}` : "no filings in the last 12 months";
        if (rows.length) li.insertAdjacentHTML("beforeend", `<ul>${rows.slice(0, 6).map(relatedRow).join("")}</ul>`);
      } catch (e) { li.querySelector(".what").textContent = `couldn't load (${e.message})`; }
    });
  } catch (e) { el.innerHTML = `<p class="relhead">Other properties <span>couldn't load (${esc(e.message)})</span></p>`; }
}
function drill(btn) {
  const box = btn.closest(".item").querySelector(".related");
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open)); box.hidden = open;
  if (open || box.dataset.loaded) return;
  box.dataset.loaded = "1";
  const { street, unit, name, owner, parcel, uid } = btn.dataset;
  const parts = [];
  if (street) parts.push(`<section><h4>At this address <span>“${esc(fmtAddr(street))}”</span>${unit ? ` <label class="unitonly"><input type="checkbox"> Only Ste ${esc(unit)}</label>` : ""}</h4>
    ${RELATED_MODULES.map(([m, label]) => `<div class="rel" id="rel-${uid}-a-${m}"><p class="relhead">${label} <span>asking the city…</span></p></div>`).join("")}</section>`);
  if (owner) parts.push(`<section><h4>Same property owner <span>${esc(titleCase(owner.replace(/\s+/g, " ").replace(/\s*&\s*$/, "")))}</span></h4><div class="rel" id="rel-${uid}-o"><p class="relhead">Other properties <span>looking up…</span></p></div></section>`);
  if (name) parts.push(`<section><h4>Same business name <span>“${esc(titleCase(name))}”</span></h4>
    ${[["licenses", "Business licenses"], ["permits", "Permits"]].map(([m, label]) => `<div class="rel" id="rel-${uid}-n-${m}"><p class="relhead">${label} <span>asking the city…</span></p></div>`).join("")}</section>`);
  box.innerHTML = parts.join("") + `<p class="note">Live from the city's public records. Food-related records are highlighted. Records about private homes and people are left out.</p>`;
  const unitBox = box.querySelector(".unitonly input");
  if (unitBox) unitBox.addEventListener("change", () => box.classList.toggle("unit-filter", unitBox.checked));
  if (street) RELATED_MODULES.forEach(([m, label]) => moduleBlock(document.getElementById(`rel-${uid}-a-${m}`), street, m, label, unit));
  if (owner) ownerBlock(document.getElementById(`rel-${uid}-o`), owner, parcel);
  if (name) [["licenses", "Business licenses"], ["permits", "Permits"]].forEach(([m, label]) => moduleBlock(document.getElementById(`rel-${uid}-n-${m}`), name, m, label));
}

/* ---------------------------------------------------------------- render */
let fitOnce = false;
function render() {
  const all = places();
  setStageCounts(all);
  const list = currentPlaces();
  const openKeys = new Set([...document.querySelectorAll(".item")].filter((el) => el.querySelector('.drill[aria-expanded="true"]')).map((el) => el.dataset.key));
  layer.clearLayers(); state.markers.clear();
  const bounds = [];
  list.forEach((p, i) => {
    if (p.lat == null || p.private) return;
    const color = STAGES[STAGE_INDEX[p.stage]].color;
    const m = L.marker([p.lat, p.lng], { icon: pin(color) }).bindTooltip(esc(p.name || fmtAddr(streetOnly(p.address)) || "")).on("click", () => focus(i, false)).addTo(layer);
    state.markers.set(i, m); bounds.push([p.lat, p.lng]);
  });
  const unmapped = list.length - bounds.length;
  $("list").innerHTML = `<p class="status">${esc(state.status)}${list.length ? ` ${list.length} places${unmapped ? ` · ${unmapped} not on the map` : ""}.` : ""}</p>` +
    (list.length ? list.map((p, i) => `<article class="item" data-i="${i}" data-key="${esc(p.key)}">${placeCard(p, i)}</article>`).join("") : state.loading ? "" : `<p class="empty">Nothing food-related matches these filters.</p>`);
  if (bounds.length && !fitOnce) { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 }); fitOnce = !state.loading; }
  $("list").querySelectorAll(".item").forEach((el) => {
    if (openKeys.has(el.dataset.key)) { const b = el.querySelector(".drill"); if (b) drill(b); }
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".drill");
      if (b) { drill(b); return; }
      if (!e.target.closest("a, .related, label")) focus(Number(el.dataset.i), true);
    });
  });
  $("c-radar").textContent = allFeeds().some((f) => f.page) ? all.filter((p) => !p.routine).length : "";
}
function focus(i, fromList) {
  document.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
  const el = document.querySelector(`.item[data-i="${i}"]`);
  if (el) { el.classList.add("active"); if (!fromList) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
  const m = state.markers.get(i);
  if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 16)); m.openTooltip(); }
}

/* ---------------------------------------------------------------- load on demand */
async function load() {
  state.token.cancelled = true;
  const token = (state.token = { cancelled: false });
  const since = cutoff();
  state.loading = true; fitOnce = false;
  const t0 = performance.now();
  const pending = [];
  const onPage = (rows) => { pending.push(enrich(rows).then(() => { if (!token.cancelled) render(); })); render(); };
  try {
    state.status = "Searching permits, plans, licenses, inspections and planning cases for food-related work…"; render();
    await Promise.all([loadLiquor(), loadPlanning().then(() => !token.cancelled && render()), ...allFeeds().map((f) => f.extend(since, onPage, token))]);
    await Promise.all(pending);
    if (token.cancelled) return;
    state.status = `Live from public records as of ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} (${((performance.now() - t0) / 1000).toFixed(1)}s).`;
  } catch (e) {
    if (token.cancelled) return;
    state.status = `Couldn't reach a data source (${e.message}). Try again in a minute.`;
  }
  state.loading = false;
  render(); renderSources();
  $("updated").textContent = `Live data · checked ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/* ---------------------------------------------------------------- data sources page */
function feedSummary(match) {
  return Object.entries(log.feeds).filter(([k, v]) => match(k) && v.pages).map(([k, v]) => {
    const ex = Object.entries(v.excluded).map(([r, n]) => `${n} ${r.toLowerCase()}`).join(", ");
    return `${k}: ${v.pages} page(s), ${v.read} read, ${v.kept} kept${ex ? `, left out ${ex}` : ""}`;
  }).join(" · ");
}
const SOURCES = [
  { name: "City permits, plans, licenses and inspections", org: "City of Columbia · EnerGov Self Service public search, via the Radar relay", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => (feedSummary(() => true) ? `${feedSummary(() => true)}.${log.notFood ? ` ${log.notFood} records matched a search word but didn't look food-related, so they're hidden.` : ""}` : "Searching when the radar loads."),
    used: [["Permits, plans and licenses matching your food words", `one search per record type (now: ${words().join(", ")})`],
      ["Food establishment and \"new business\" inspections", "show a place getting ready to open; on their own they're treated as routine"],
      ["Type, status, dates, description, address, parcel", "what's happening, where and how far along"],
      ["License company, DBA and opened date", "names the place; a renewal vs. a new business"],
      ["Stage", "planning → construction → licensing → inspections → signage, from the record types found at each place"]],
    skipped: [["Records that match a word but not food", "e.g. a school addition with a kitchen; hidden unless the type or description is food-related"],
      ["Residential permits, rental licenses, licenses issued to individual people", "dropped by the relay"],
      ["Holder names, tax IDs, applicant and contractor contacts", "stripped by the relay"],
      ["Addresses of home-based food businesses", "shown as \"home-based\" with no address, pin or Street View"]] },
  { name: "Related records (drill-down)", org: "City of Columbia · EnerGov public search via the relay, plus the county parcel layer", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => (log.related.lookups ? `This visit: ${log.related.lookups} lookups, ${log.related.records} records shown; ${log.owners.lookups} owner lookups found ${log.owners.parcels} other properties${Object.keys(log.related.excluded).length ? `; left out ${Object.entries(log.related.excluded).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}` : ""}.` : "Runs when you click Related records."),
    used: [["Everything at the address", "permits, plans, licenses, inspections and code cases, newest 25 of each, with an only-this-unit filter"],
      ["Same property owner", "the owner's other parcels (companies only), then each one's permits, plans and licenses from the last 12 months"],
      ["Same business name", "the business's other licenses and permits"]],
    skipped: [["Code case and inspection descriptions", "can describe complaints about people"], ["Owners who are individuals", "no same-owner lookup for people"], ["Animal control and COVID-order records", "noise; dropped by the relay"]] },
  { name: "Planning cases", org: "City of Columbia GIS · CurrentPlanningCases, queried directly", url: "https://gis.gocolumbiamo.com/arcgis/rest/services/CurrentPlanningCases/MapServer/0",
    live: () => (planning ? `This visit: ${log.planning.read} cases from the last 12 months whose title mentions a food word.` : "Loaded with the radar."),
    used: [["Case title, filing date, application PDF, boundary", "rezonings and concept plans that mention food"]], skipped: [["Cases without a food word in the title", "outside this radar's focus"]] },
  { name: "Parcels, owners and zoning", org: "City of Columbia GIS · parcel layer (Boone County Assessor) and zoning, queried directly", url: "https://gis.gocolumbiamo.com/arcgis/rest/services/Energov/Energov_View/MapServer/0",
    live: () => (log.parcels ? `This visit: ${log.parcels} parcels looked up.` : "Looked up as records load."),
    used: [["Parcel shape", "map pin and Street View location"], ["Zoning district", "what the land allows"], ["Property owner when it's a company", "shown, and used for the same-owner drill-down"]],
    skipped: [["Property owner when it's a person", "never shown or searched"], ["Owner mailing address", "personal contact info"]] },
  { name: "Liquor licenses", org: "State of Missouri via data.mo.gov, queried directly", url: "https://data.mo.gov/Regulatory/Missouri-Primary-Alcohol-Licenses/d9fr-pncw",
    live: () => (log.liquor ? `This visit: ${log.liquor} Columbia liquor licenses matched to places by name.` : "Loaded with the radar."),
    used: [["License type", "shown on matching places"]], skipped: [["Managing officer's name and phone numbers", "personal contact info"]] },
  { name: "Google Street View and Maps", org: "Google · links only, open in a new tab", url: "https://www.google.com/maps",
    live: () => "Linked, not pulled.", used: [["Street View at the parcel, Maps search for the address", "for commercial places"]], skipped: [["Links for home-based businesses", "someone's home"]] },
];
function renderSources() {
  $("sourceList").innerHTML = SOURCES.map((s) => `
    <article class="source">
      <h3>${esc(s.name)}</h3>
      <p class="meta">${esc(s.org)} · ${ext(s.url, "open source")}</p>
      <p class="stat">${esc(s.live())}</p>
      <div class="cols">
        <div class="used"><h4>Used</h4><ul>${s.used.map(([a, b]) => `<li>${esc(a)} <span>· ${esc(b)}</span></li>`).join("")}</ul></div>
        <div class="skipped"><h4>Not used</h4><ul>${s.skipped.map(([a, b]) => `<li>${esc(a)} <span>· ${esc(b)}</span></li>`).join("")}</ul></div>
      </div>
    </article>`).join("");
}

/* ---------------------------------------------------------------- wiring */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("explore").hidden = tab !== "radar"; $("sources").hidden = tab === "radar";
  if (tab === "radar") setTimeout(() => map.invalidateSize(), 0); else renderSources();
}
// External links always open in a new tab, even where the browser would otherwise reuse this one.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.ext, .leaflet-control-attribution a");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  window.open(a.href, "_blank", "noopener,noreferrer");
});
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
["q", "stage", "showRoutine"].forEach((id) => $(id).addEventListener("input", () => { fitOnce = false; render(); }));
$("days").addEventListener("change", load);
$("words").addEventListener("change", () => { store.set("food-words", $("words").value); planning = null; load(); });
renderSources();
setTab("radar");
load();
