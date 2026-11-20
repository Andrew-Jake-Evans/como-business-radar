/* CoMo Business Radar: queries public records live, on demand, for the filters you pick. */
const RELAY = window.RADAR_RELAY;
const GIS = "https://gis.gocolumbiamo.com/arcgis/rest/services";
const PARCELS = `${GIS}/Energov/Energov_View/MapServer/0`;
const ZONING = `${GIS}/View_Services/Zoning_Current/MapServer/0`;
const PLANNING = `${GIS}/CurrentPlanningCases/MapServer/0`;
const LIQUOR = "https://data.mo.gov/resource/d9fr-pncw.json";
const PAGE_SIZE = 100;
const DEFAULT_WATCH = "restaurant, food";
const ENTITY = /\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|PARTNERS|PARTNERSHIP|PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|DEVELOPMENT|REALTY|GROUP|BANK|CHURCH|UNIVERSITY|CITY OF|COUNTY|SCHOOL|DISTRICT|ASSOCIATION|ASSN|FOUNDATION|CURATORS|STATE OF|HOSPITAL|PLAZA|CENTER|MALL)\b/i;
const LOCAL = new Set(["COLUMBIA", "COL"]);
const PLAN_TYPES = { SUBD: "Subdivision plat", ANX: "Annexation", AA: "Annexation agreement", RZN: "Rezoning", PDV: "Planned development",
  CR: "Concept review", CUP: "Conditional use permit", BOA: "Board of Adjustment (variance)", HIS: "Historic preservation",
  VAC: "Right-of-way vacation", UDC: "Development code amendment" };
// Permit types that are a project's main record; everything else at the same address is a sub-permit.
const PRIMARY_PERMIT = /^(Commercial|Sign$|New Commercial|Tenant|Change of Occupancy|Land disturbance)/i;
const SUB_PERMIT = /Sub Permit|Service Request|Stand Alone|Large Tap|Temporary Take-Down/i;

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
// "2101 W BROADWAY STE F1 COLUMBIA MO 65203" -> "2101 W BROADWAY" (what the city's search matches best)
const streetOnly = (a) => (a || "").replace(/\s+(COLUMBIA|COL)\s+MO\b.*$/i, "").replace(/\s+(STE|APT|UNIT|SUITE|BLDG|#)\b.*$/i, "").trim();
const unitOf = (a) => ((a || "").match(/\b(STE|APT|UNIT|SUITE)\s+([A-Z0-9-]+)/i) || [])[2]?.toUpperCase() || "";
const watchWords = () => ($("watch").value || "").split(",").map((w) => w.trim()).filter((w) => KEYWORD_RE.test(w)).slice(0, 6);

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `${r.status} from ${new URL(url, location.href).host}`);
  return d;
}
async function gisQuery(layer, params) {
  return getJSON(`${layer}/query`, { method: "POST", body: new URLSearchParams({ f: "json", ...params }) });
}

/* ---------------------------------------------------------------- session log (shown on Data sources) */
const log = { feeds: {}, related: { lookups: 0, records: 0, excluded: {} }, planning: { read: 0, skipped: 0 },
  parcels: { looked_up: 0 }, liquor: { loaded: 0 } };
const addExcluded = (t, ex) => { for (const [k, n] of Object.entries(ex || {})) t[k] = (t[k] || 0) + n; };

/* ---------------------------------------------------------------- live feeds */
// One feed per relay search; pages are fetched newest-first until they pass the date window.
class Feed {
  constructor(kind, keyword = "", exact = false) {
    Object.assign(this, { kind, keyword, exact, rows: [], page: 0, oldest: null, newest: null, done: false });
    this.label = keyword ? `${kind} matching "${keyword}"` : kind;
    log.feeds[this.label] = log.feeds[this.label] || { pages: 0, read: 0, kept: 0, excluded: {} };
  }
  covers(cutoff) { return this.done || (this.oldest && new Date(this.oldest) < cutoff); }
  async fetchPage(p) {
    const q = new URLSearchParams({ kind: this.kind, page: p, size: PAGE_SIZE });
    if (this.keyword) q.set("keyword", this.keyword);
    if (this.exact) q.set("exact", "1");
    return getJSON(`${RELAY}/search?${q}`);
  }
  take(d, onPage) {
    this.page = Math.max(this.page, d.page);
    if (d.oldest && (!this.oldest || d.oldest < this.oldest)) this.oldest = d.oldest;
    if (!d.has_more) this.done = true;
    d.rows.forEach((r) => { r.via = this.keyword || this.kind; });
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
const feed = (kind, keyword = "", exact = false) => {
  const k = `${kind}|${keyword.toLowerCase()}|${exact}`;
  if (!feeds.has(k)) feeds.set(k, new Feed(kind, keyword, exact));
  return feeds.get(k);
};
const activityFeeds = () => [feed("permits", "Commercial"), feed("permits", "Sign", true),
  ...watchWords().flatMap((w) => [feed("permits", w), feed("plans", w)])];

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
        const owner = (f.attributes.OWNER1 || "").replace(/\s+/g, " ").trim();
        parcels.set(f.attributes.PARCEL, {
          lat: pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null,
          lng: pts.length ? pts.reduce((s, p) => s + p[0], 0) / pts.length : null,
          owner: ENTITY.test(owner) ? owner : null, zoning: null,
        });
        log.parcels.looked_up++;
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
function placeOf(r) {
  const p = r.parcel ? parcels.get(r.parcel) : null;
  const out = { lat: null, lng: null, owner: null, zoning: p?.zoning || null, masked: false };
  if (!p) return out;
  if (r.kind === "license") {
    // Licenses at residentially zoned parcels are most likely someone's home: no house number, pin, owner or Street View.
    if (p.residential) return { ...out, masked: true, zoning: null };
    if (!LOCAL.has((r.city || "").toUpperCase())) return out;
  }
  return { ...out, lat: p.lat, lng: p.lng, owner: p.owner };
}

let liquor = null;
async function loadLiquor() {
  if (liquor) return liquor;
  const q = new URLSearchParams({ $where: "upper(city) like '%COLUMBIA%' AND upper(county) like '%BOONE%'", $limit: "5000", $select: "licensee,dbaname,primary_type" });
  try {
    const rows = await getJSON(`${LIQUOR}?${q}`);
    log.liquor.loaded = rows.length;
    liquor = new Map();
    for (const r of rows) for (const k of [r.dbaname, r.licensee]) if (normName(k) && !liquor.has(normName(k))) liquor.set(normName(k), r);
  } catch { liquor = new Map(); }
  return liquor;
}

let planningCache = null;
async function loadPlanning() {
  if (planningCache) return planningCache;
  const since = new Date(Date.now() - 365 * 864e5);
  const yymmdd = `${String(since.getFullYear()).slice(2)}${String(since.getMonth() + 1).padStart(2, "0")}${String(since.getDate()).padStart(2, "0")}`;
  const res = await gisQuery(PLANNING, { where: `cent = 1 AND app_dat >= ${yymmdd}`, outFields: "PZ_OPTVW,ext_desc,typ_code,app_dat,Link,Board_Report_Link,Council_Report_Link",
    returnGeometry: "true", outSR: "4326", maxAllowableOffset: "0.0001", orderByFields: "app_dat DESC" });
  // Short-term rental permits are about private homes, so they're left out like rental licenses.
  const feats = (res.features || []).filter((f) => !/SHORT[- ]TERM RENTAL/i.test(f.attributes.ext_desc || ""));
  log.planning = { read: feats.length, skipped: (res.features || []).length - feats.length };
  planningCache = feats.map((f) => {
    const a = f.attributes; const d = String(a.app_dat || ""); const pts = (f.geometry?.rings || []).flat();
    return { kind: "case", id: a.PZ_OPTVW, title: a.ext_desc, type: PLAN_TYPES[(a.typ_code || "").trim()] || `Other (${(a.typ_code || "").trim() || "no code"})`,
      applied: d.length === 6 ? `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}T12:00:00` : null,
      links: [["Application", a.Link], ["Board report", a.Board_Report_Link], ["Council report", a.Council_Report_Link]].filter(([, u]) => u),
      lat: pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null, lng: pts.length ? pts.reduce((s, p) => s + p[0], 0) / pts.length : null };
  });
  return planningCache;
}

/* ---------------------------------------------------------------- shaping */
function shapeLicense(r) {
  const opened = r.company_opened ? new Date(r.company_opened) : null;
  r.likely_new = !opened || opened >= new Date(new Date(r.applied) - 120 * 864e5);
  r.local = LOCAL.has((r.city || "").toUpperCase());
  const m = (r.license_type || "").split(/\s[–-]\s/);
  r.group = m.length > 1 && /^(General Business License|Home Occupation)/.test(m[0]) ? m[1].trim()
    : /^Construction/.test(r.license_type) ? "Construction" : /^(Accom|Liquor)/.test(r.license_type) ? "Accommodation and Food Services"
    : /^Retail/.test(r.license_type) ? "Retail Trade" : /Marijuana/.test(r.license_type) ? "Cannabis" : "Other";
  const hit = liquor && (liquor.get(normName(r.dba)) || liquor.get(normName(r.company)));
  r.liquor = hit ? { type: hit.primary_type, licensee: hit.licensee } : null;
  return r;
}

// Collapse permits and plans into projects: one main record per address + description, with its sub-permits.
function projects() {
  const words = watchWords().map((w) => w.toLowerCase());
  const seen = new Map();
  for (const f of activityFeeds()) for (const r of f.rows) if (!seen.has(r.id)) seen.set(r.id, { ...r, vias: new Set([r.via]) }); else seen.get(r.id).vias.add(r.via);
  const groups = new Map();
  for (const r of seen.values()) {
    const key = `${(r.address || r.parcel || r.id).toUpperCase()}|${(r.description || r.project || r.id).toLowerCase().slice(0, 60)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((list) => {
    list.sort((a, b) => (PRIMARY_PERMIT.test(b.type) - PRIMARY_PERMIT.test(a.type)) || (SUB_PERMIT.test(a.type) - SUB_PERMIT.test(b.type)) || (a.applied || "").localeCompare(b.applied || ""));
    const main = list[0];
    // Count a watch word only when the work itself mentions it (not just the street name, e.g. Restaurant Row).
    const hits = words.filter((w) => list.some((r) => `${r.description || ""} ${r.type || ""} ${r.project || ""}`.toLowerCase().includes(w)));
    const category = main.kind === "plan" ? "Early plans" : hits.length ? "Food & restaurants" : /^Sign$/i.test(main.type) ? "Signs" : "Commercial construction";
    return { ...main, others: list.slice(1), hits, category, applied: list.map((r) => r.applied).filter(Boolean).sort().pop() };
  });
}

/* ---------------------------------------------------------------- UI state */
const state = { tab: store.get("radar-tab") || "activity", token: { cancelled: true }, markers: new Map(), status: "", loading: false };
if (!["activity", "licenses", "planning", "sources"].includes(state.tab)) state.tab = "activity";
$("watch").value = store.get("radar-watch") || DEFAULT_WATCH;
const COLORS = { activity: "#b45309", licenses: "#1d4ed8", planning: "#7e22ce" };
const map = L.map("map", { scrollWheelZoom: false }).setView([38.9517, -92.3341], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
const layer = L.layerGroup().addTo(map);
const pin = (c) => L.divIcon({ className: "", html: `<div class="pin" style="background:${c}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
const cutoff = () => new Date(Date.now() - Number($("days").value) * 864e5);

function allRows(tab) {
  if (tab === "activity") return projects();
  if (tab === "licenses") return feed("licenses").rows.map(shapeLicense);
  return planningCache || [];
}
const groupKey = (tab, r) => (tab === "activity" ? r.category : tab === "licenses" ? r.group : r.type);
function currentRows(tab = state.tab) {
  const since = cutoff();
  const q = $("q").value.trim().toLowerCase();
  const group = tab === state.tab ? $("group").value : "";
  let list = allRows(tab).filter((r) => r.applied && new Date(r.applied) >= since);
  if (tab === "licenses") {
    if ($("onlyNew").checked) list = list.filter((r) => r.likely_new);
    if ($("onlyLocal").checked) list = list.filter((r) => r.local);
  }
  if (group) list = list.filter((r) => groupKey(tab, r) === group);
  if (q) list = list.filter((r) => JSON.stringify({ ...r, vias: undefined }).toLowerCase().includes(q));
  return list.sort((a, b) => (b.applied || "").localeCompare(a.applied || ""));
}
function setGroups() {
  const label = { activity: "All new activity", licenses: "All industries", planning: "All case types" }[state.tab];
  const keep = $("group").value;
  const counts = {};
  allRows(state.tab).filter((r) => r.applied && new Date(r.applied) >= cutoff()).forEach((r) => { const k = groupKey(state.tab, r); counts[k] = (counts[k] || 0) + 1; });
  $("group").innerHTML = `<option value="">${label}</option>` + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${esc(k)}">${esc(k)} (${n})</option>`).join("");
  if (counts[keep]) $("group").value = keep;
}

/* ---------------------------------------------------------------- cards */
function placeLinks(r, place) {
  if (place.masked || !r.address || (r.kind === "license" && !r.local)) return "";
  const sv = place.lat != null ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${place.lat.toFixed(6)},${place.lng.toFixed(6)}` : null;
  const gm = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`;
  return `${sv ? `<a href="${sv}" target="_blank" rel="noopener">Street View</a>` : ""}<a href="${gm}" target="_blank" rel="noopener">Google Maps</a>`;
}
function relatedButton(r, place, uid) {
  const street = streetOnly(r.address);
  const name = r.kind === "license" ? (r.dba || r.company || "") : "";
  const canAddr = !place.masked && !r.home_based && street && KEYWORD_RE.test(street);
  const canName = name && KEYWORD_RE.test(name.slice(0, 60));
  if (!canAddr && !canName) return "";
  const unit = unitOf(r.address);
  return `<button class="drill" data-uid="${uid}" data-street="${canAddr ? esc(street) : ""}" data-unit="${canAddr ? esc(unit) : ""}" data-name="${canName ? esc(name.slice(0, 60)) : ""}" aria-expanded="false">Related records</button>`;
}
function activityCard(r, uid) {
  const place = placeOf(r);
  const others = r.others.length ? ` · +${r.others.length} related ${r.others.length === 1 ? "permit" : "permits"}` : "";
  return `
    <h3>${esc(fmtAddr(r.address) || r.project || "Commercial project")}</h3>
    <p class="legal">${r.kind === "plan" ? "Plan" : "Permit"}: ${esc(r.type)}${others}</p>
    ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
    <div class="tags">
      ${r.hits.map((h) => `<span class="tag new">${esc(h)}</span>`).join("")}
      <span class="tag">${esc(r.category)}</span><span class="tag">${esc(r.status)}</span>
      ${place.zoning ? `<span class="tag">Zoned ${esc(place.zoning)}</span>` : ""}
    </div>
    <dl class="facts">
      <dt>Latest filing</dt><dd>${fmtDate(r.applied)}${r.issued ? ` · issued ${fmtDate(r.issued)}` : ""}</dd>
      ${place.owner ? `<dt>Property owner</dt><dd>${esc(titleCase(place.owner))}</dd>` : ""}
      <dt>Records</dt><dd>${esc(r.id)}${r.others.length ? ` · ${r.others.map((o) => esc(o.type)).join(", ")}` : ""}</dd>
    </dl>
    <div class="links">${relatedButton(r, place, uid)}${placeLinks(r, place)}</div>
    <div class="related" hidden></div>`;
}
function licenseCard(r, uid) {
  const place = placeOf(r);
  const name = titleCase(r.dba || r.company || "Unnamed business");
  const legal = r.dba && r.company && normName(r.dba) !== normName(r.company) ? titleCase(r.company) : "";
  const where = r.home_based ? `Home-based business${r.city ? `, ${esc(titleCase(r.city))}` : ""}`
    : place.masked ? `Residential area on ${esc(fmtAddr(streetOnly(r.address).replace(/^\d+\s+/, "")))}` : esc(fmtAddr(r.address) || "No address listed");
  const lookup = encodeURIComponent(r.company || r.dba || "");
  return `
    <h3>${esc(name)}</h3>
    <p class="legal">${legal ? `${esc(legal)} · ` : ""}${esc(r.company_type || "")}</p>
    ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
    <div class="tags">
      ${r.likely_new ? '<span class="tag new">Likely new</span>' : '<span class="tag">Renewal or existing</span>'}
      ${!r.local && r.city ? `<span class="tag away">Based in ${esc(titleCase(r.city))}</span>` : ""}
      ${r.industry || r.group ? `<span class="tag">${esc(r.industry || r.group)}</span>` : ""}
      <span class="tag">${esc(r.status)}</span>
    </div>
    <dl class="facts">
      <dt>Applied</dt><dd>${fmtDate(r.applied)}${r.issued ? ` · issued ${fmtDate(r.issued)}` : ""}</dd>
      <dt>Location</dt><dd>${where}</dd>
      ${place.zoning ? `<dt>Zoning</dt><dd>${esc(place.zoning)}</dd>` : ""}
      ${place.owner ? `<dt>Property owner</dt><dd>${esc(titleCase(place.owner))}</dd>` : ""}
      ${r.liquor ? `<dt>Liquor license</dt><dd>${esc(r.liquor.type)} · ${esc(titleCase(r.liquor.licensee))}</dd>` : ""}
      <dt>License</dt><dd>${esc(r.id)} · ${esc(r.license_type)}</dd>
    </dl>
    <div class="links">
      ${relatedButton(r, place, uid)}${placeLinks(r, place)}
      <a href="https://opencorporates.com/companies/us_mo?q=${lookup}" target="_blank" rel="noopener">Company filings</a>
      <a href="https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx?SearchType=0" target="_blank" rel="noopener">Missouri SOS</a>
    </div>
    <div class="related" hidden></div>`;
}
function planCard(r) {
  const links = r.links.map(([t, u]) => `<a href="${esc(u.replace(/^http:/, "https:"))}" target="_blank" rel="noopener">${t} (PDF)</a>`).join("");
  const sv = r.lat != null ? `<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${r.lat.toFixed(6)},${r.lng.toFixed(6)}" target="_blank" rel="noopener">Street View</a>` : "";
  return `
    <h3>${esc(titleCase(r.title) || r.id)}</h3>
    <p class="legal">${esc(r.type)} · ${esc(r.id)}</p>
    <dl class="facts"><dt>Filed</dt><dd>${fmtDate(r.applied)}</dd></dl>
    <div class="links">${links}${sv}</div>`;
}

/* ---------------------------------------------------------------- drill-down */
const RELATED_MODULES = [["permits", "Permits"], ["plans", "Plans"], ["licenses", "Business licenses"], ["inspections", "Inspections"], ["codecases", "Code cases"]];
const relatedCache = new Map();
function related(q, module) {
  const k = `${q.toUpperCase()}|${module}`;
  if (!relatedCache.has(k)) {
    relatedCache.set(k, getJSON(`${RELAY}/related?${new URLSearchParams({ q, module, size: 25 })}`).then((d) => {
      log.related.lookups++; log.related.records += d.rows.length; addExcluded(log.related.excluded, d.excluded); return d;
    }).catch((e) => { relatedCache.delete(k); throw e; }));
  }
  return relatedCache.get(k);
}
function relatedRow(r) {
  const what = r.kind === "license" ? titleCase(r.dba || r.company || "") : r.description || "";
  const unit = (r.address || "").match(/\b(STE|APT|Unit)\s+\S+/i)?.[0] || "";
  return `<li data-unit="${esc(unitOf(r.address))}"><span class="when">${fmtDate(r.applied)}</span> <strong>${esc(r.type)}</strong>${r.status ? ` · ${esc(r.status)}` : ""}${unit ? ` · ${esc(fmtAddr(unit))}` : ""}${what ? `<br><span class="what">${esc(what.slice(0, 160))}</span>` : ""}</li>`;
}
function drill(btn) {
  const box = btn.closest(".item").querySelector(".related");
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open)); box.hidden = open;
  if (open || box.dataset.loaded) return;
  box.dataset.loaded = "1";
  const sections = [];
  if (btn.dataset.street) sections.push(["At this address", btn.dataset.street, RELATED_MODULES]);
  if (btn.dataset.name) sections.push(["Same business name", btn.dataset.name, RELATED_MODULES.filter(([m]) => ["licenses", "permits"].includes(m))]);
  const uid = btn.dataset.uid;
  box.innerHTML = sections.map(([title, q, mods], si) => `
    <section><h4>${esc(title)} <span>“${esc(fmtAddr(q))}”</span>${si === 0 && btn.dataset.street && btn.dataset.unit ? ` <label class="unitonly"><input type="checkbox"> Only Ste ${esc(btn.dataset.unit)}</label>` : ""}</h4>
      ${mods.map(([m, label]) => `<div class="rel" id="rel-${uid}-${si}-${m}"><p class="relhead">${label} <span>asking the city…</span></p></div>`).join("")}
    </section>`).join("") + `<p class="note">Live from the city's public records. Records about private homes and people are left out.</p>`;
  const unitBox = box.querySelector(".unitonly input");
  if (unitBox) unitBox.addEventListener("change", () => box.classList.toggle("unit-filter", unitBox.checked));
  box.dataset.unit = btn.dataset.unit || "";
  sections.forEach(([, q, mods], si) => mods.forEach(async ([m, label]) => {
    const el = document.getElementById(`rel-${uid}-${si}-${m}`);
    try {
      const d = await related(q, m);
      const rows = [...d.rows].sort((a, b) => (b.applied || "").localeCompare(a.applied || ""));
      const left = Object.values(d.excluded || {}).reduce((a, b) => a + b, 0);
      const more = d.total > d.read ? ` · newest ${d.read} of ${d.total}` : "";
      el.innerHTML = `<p class="relhead">${label} <span>${rows.length}${more}${left ? ` · ${left} left out` : ""}</span></p>` + (rows.length ? `<ul>${rows.map(relatedRow).join("")}</ul>` : "");
      if (box.dataset.unit) el.querySelectorAll("li").forEach((li) => li.classList.toggle("other-unit", li.dataset.unit !== box.dataset.unit));
    } catch (e) { el.innerHTML = `<p class="relhead">${label} <span>couldn't load (${esc(e.message)})</span></p>`; }
  }));
}

/* ---------------------------------------------------------------- render */
let fitOnce = false;
function render() {
  const list = currentRows();
  const card = { activity: activityCard, licenses: licenseCard, planning: planCard }[state.tab];
  // Keep drill-downs the reader has open across re-renders while pages stream in.
  const openIds = new Set([...document.querySelectorAll(".item")].filter((el) => el.querySelector('.drill[aria-expanded="true"]')).map((el) => el.dataset.id));
  layer.clearLayers(); state.markers.clear();
  const bounds = [];
  let unmapped = 0;
  list.forEach((r, i) => {
    const p = r.kind === "case" ? r : placeOf(r);
    if (p.lat == null) { unmapped++; return; }
    const m = L.marker([p.lat, p.lng], { icon: pin(COLORS[state.tab]) })
      .bindTooltip(esc(titleCase(r.dba || r.company || r.title || "") || fmtAddr(r.address) || r.id))
      .on("click", () => focus(i, false)).addTo(layer);
    state.markers.set(i, m); bounds.push([p.lat, p.lng]);
  });
  const head = `<p class="status">${esc(state.status)}${list.length ? ` ${list.length} shown${unmapped ? ` · ${unmapped} not on the map` : ""}.` : ""}</p>`;
  $("list").innerHTML = head + (list.length ? list.map((r, i) => `<article class="item" data-i="${i}" data-id="${esc(r.id)}">${card(r, i)}</article>`).join("")
    : state.loading ? "" : `<p class="empty">Nothing matches these filters.</p>`);
  if (bounds.length && !fitOnce) { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 }); fitOnce = !state.loading; }
  $("list").querySelectorAll(".item").forEach((el) => {
    if (openIds.has(el.dataset.id)) { const b = el.querySelector(".drill"); if (b) drill(b); }
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".drill");
      if (b) { drill(b); return; }
      if (!e.target.closest("a, .related")) focus(Number(el.dataset.i), true);
    });
  });
  for (const t of ["activity", "licenses", "planning"]) {
    const has = t === "activity" ? activityFeeds().some((f) => f.page) : t === "licenses" ? feed("licenses").page : planningCache;
    $(`c-${t}`).textContent = has ? currentRows(t).length : "";
  }
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
  const onPage = (rows) => { pending.push(enrich(rows).then(() => { if (!token.cancelled) { setGroups(); render(); } })); setGroups(); render(); };
  try {
    if (state.tab === "activity") {
      state.status = `Asking the city for commercial and sign permits${watchWords().length ? `, plus permits and plans mentioning ${watchWords().join(" or ")}` : ""}…`; render();
      await Promise.all(activityFeeds().map((f) => f.extend(since, onPage, token)));
    } else if (state.tab === "licenses") {
      await loadLiquor();
      state.status = "Asking the city for business licenses…"; render();
      await feed("licenses").extend(since, (rows) => { state.status = `Read license records back to ${fmtDate(feed("licenses").oldest)}…`; onPage(rows); }, token);
    } else if (state.tab === "planning") {
      state.status = "Loading planning cases…"; render();
      await loadPlanning();
    }
    await Promise.all(pending);
    if (token.cancelled) return;
    state.status = `Live from public records as of ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} (${((performance.now() - t0) / 1000).toFixed(1)}s).`;
  } catch (e) {
    if (token.cancelled) return;
    state.status = `Couldn't reach a data source (${e.message}). Try again in a minute.`;
  }
  state.loading = false;
  setGroups(); render(); renderSources();
  $("updated").textContent = `Live data · checked ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/* ---------------------------------------------------------------- data sources page */
function feedSummary(match) {
  const rows = Object.entries(log.feeds).filter(([k, v]) => match(k) && v.pages);
  return rows.map(([k, v]) => {
    const ex = Object.entries(v.excluded).map(([r, n]) => `${n} ${r.toLowerCase()}`).join(", ");
    return `${k}: ${v.pages} page(s), ${v.read} read, ${v.kept} kept${ex ? `, left out ${ex}` : ""}`;
  }).join(" · ");
}
const SOURCES = [
  { name: "Permits and plans (the main signal)", org: "City of Columbia · EnerGov Self Service public search, via the Radar relay", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => feedSummary((k) => /^(permits|plans)/.test(k)) || "Not queried yet this visit. Open New activity.",
    used: [["Commercial permits and sign permits", "new buildings, tenant finishes, storefront signs"], ["Permits and plans matching your watch words", `keyword search (now: ${watchWords().join(", ") || "none"})`],
      ["Plans: zoning letters and concept reviews", "often the earliest sign something is coming"], ["Type, status, dates, description, address, parcel", "what, where and how far along"],
      ["Sub-permits at the same address", "grouped under one project"]],
    skipped: [["Residential permits (houses, roofs, decks, home solar)", "private homes; dropped by the relay"], ["Applicant and contractor contacts", "people's contact details; stripped by the relay"]] },
  { name: "Business licenses", org: "City of Columbia · EnerGov Self Service public search, via the Radar relay", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => feedSummary((k) => k === "licenses") || "Not queried yet this visit. Open Business licenses.",
    used: [["Company, DBA, company type, industry", "who the business is"], ["Applied and issued dates, status", "where it is in review"], ["Owner-written description", "the business describing itself"],
      ["Company opened date", "likely new = no opened date, or opened within 120 days of applying"], ["Address and parcel", "with the exceptions listed here"]],
    skipped: [["Rental and short-term rental licenses", "private homes; dropped by the relay"], ["Licenses issued to individual people", "plumbers, guards, parking hangtags; dropped by the relay"],
      ["Holder names and tax IDs", "stripped by the relay"], ["Home-based business addresses", "stripped by the relay"], ["House number, pin and Street View for licenses on residential parcels", "most likely someone's home"]] },
  { name: "Related records (drill-down)", org: "City of Columbia · EnerGov Self Service public search, via the Radar relay", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => log.related.lookups ? `This visit: ${log.related.lookups} lookups, ${log.related.records} records shown${Object.keys(log.related.excluded).length ? `; left out ${Object.entries(log.related.excluded).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}` : ""}.` : "Runs when you click Related records on an item.",
    used: [["Permits, plans, licenses, inspections and code cases at an address", "newest 25 of each, searched by street address"], ["Other licenses and permits under the same business name", "for business licenses"],
      ["Inspection and code case type, status and dates", "e.g. a food establishment inspection before opening"]],
    skipped: [["Code case and inspection descriptions", "can describe complaints about people"], ["Animal control and COVID-order records", "noise; dropped by the relay"],
      ["Drill-down by address for home-based or residential-parcel licenses", "someone's home"]] },
  { name: "Planning and zoning cases", org: "City of Columbia GIS · CurrentPlanningCases, queried directly", url: "https://gis.gocolumbiamo.com/arcgis/rest/services/CurrentPlanningCases/MapServer/0",
    live: () => log.planning.read ? `This visit: ${log.planning.read} cases from the last 365 days${log.planning.skipped ? `; left out ${log.planning.skipped} short-term rental permits` : ""}.` : "Not queried yet this visit. Open Planned development.",
    used: [["Case number, title, type, filing date", "what's proposed and when"], ["Application, board and council report PDFs", "the original documents"], ["Case boundary", "shown at its center"]],
    skipped: [["Short-term rental conditional use permits", "private homes"], ["Ordinance and agenda numbers", "only meaningful after council action"]] },
  { name: "Parcels, property owners and zoning", org: "City of Columbia GIS · parcel layer (Boone County Assessor) and current zoning, queried directly", url: "https://gis.gocolumbiamo.com/arcgis/rest/services/Energov/Energov_View/MapServer/0",
    live: () => log.parcels.looked_up ? `This visit: ${log.parcels.looked_up} parcels looked up.` : "Looked up as records load.",
    used: [["Parcel shape", "map point and Street View location"], ["Zoning district", "what the land is zoned for"], ["Property owner when it's a company", "e.g. the LLC that owns the building"]],
    skipped: [["Property owner when it's a person", "never shown"], ["Owner mailing address", "personal contact info"]] },
  { name: "Liquor licenses", org: "State of Missouri · Division of Alcohol and Tobacco Control via data.mo.gov, queried directly", url: "https://data.mo.gov/Regulatory/Missouri-Primary-Alcohol-Licenses/d9fr-pncw",
    live: () => log.liquor.loaded ? `This visit: ${log.liquor.loaded} active Columbia liquor licenses matched to businesses by name.` : "Loaded with Business licenses.",
    used: [["Licensee and DBA", "who holds the license"], ["License type", "e.g. retail by the drink"]], skipped: [["Managing officer's name", "an individual"], ["Phone numbers", "personal contact info"]] },
  { name: "Google Street View and Maps", org: "Google · links only", url: "https://www.google.com/maps",
    live: () => "Linked, not pulled. Street View opens at the parcel's location; Google Maps searches the address.",
    used: [["A link per commercial property and planning case", "you open it yourself"]], skipped: [["Links for home-based or residential-parcel licenses", "someone's home"]] },
  { name: "Missouri business registrations", org: "Missouri Secretary of State and OpenCorporates", url: "https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx?SearchType=0",
    live: () => "Linked, not pulled. Each business has lookup links for its state filing.", used: [["Lookup links on each business", "you follow them yourself"]],
    skipped: [["Automated collection", "the state site has no public API and doesn't allow scraping"]] },
];
function renderSources() {
  $("sourceList").innerHTML = SOURCES.map((s) => `
    <article class="source">
      <h3>${esc(s.name)}</h3>
      <p class="meta">${esc(s.org)} · <a href="${s.url}" target="_blank" rel="noopener">open source</a></p>
      <p class="stat">${esc(s.live())}</p>
      <div class="cols">
        <div class="used"><h4>Used</h4><ul>${s.used.map(([a, b]) => `<li>${esc(a)} <span>· ${esc(b)}</span></li>`).join("")}</ul></div>
        <div class="skipped"><h4>Not used</h4><ul>${s.skipped.map(([a, b]) => `<li>${esc(a)} <span>· ${esc(b)}</span></li>`).join("")}</ul></div>
      </div>
    </article>`).join("");
}

/* ---------------------------------------------------------------- wiring */
function setTab(tab) {
  state.tab = tab; store.set("radar-tab", tab);
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  const sources = tab === "sources";
  $("explore").hidden = sources; $("sources").hidden = !sources;
  if (sources) { renderSources(); return; }
  $("newWrap").hidden = $("localWrap").hidden = tab !== "licenses";
  $("watchWrap").hidden = tab !== "activity";
  $("group").value = "";
  if (tab === "planning" && Number($("days").value) < 90) $("days").value = "90";
  setGroups(); render();
  setTimeout(() => map.invalidateSize(), 0);
  load();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
["q", "group", "onlyNew", "onlyLocal"].forEach((id) => $(id).addEventListener("input", () => { fitOnce = false; render(); }));
$("days").addEventListener("change", () => { setGroups(); load(); });
$("watch").addEventListener("change", () => { store.set("radar-watch", $("watch").value); setGroups(); load(); });
renderSources();
setTab(state.tab);
