/* CoMo Business Radar: queries public records live, on demand, for the filters you pick. */
const RELAY = window.RADAR_RELAY;
const GIS = "https://gis.gocolumbiamo.com/arcgis/rest/services";
const PARCELS = `${GIS}/Energov/Energov_View/MapServer/0`;
const ZONING = `${GIS}/View_Services/Zoning_Current/MapServer/0`;
const PLANNING = `${GIS}/CurrentPlanningCases/MapServer/0`;
const LIQUOR = "https://data.mo.gov/resource/d9fr-pncw.json";
const PAGE_SIZE = 100;
const ENTITY = /\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|PARTNERS|PARTNERSHIP|PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|DEVELOPMENT|REALTY|GROUP|BANK|CHURCH|UNIVERSITY|CITY OF|COUNTY|SCHOOL|DISTRICT|ASSOCIATION|ASSN|FOUNDATION|CURATORS|STATE OF|HOSPITAL|PLAZA|CENTER|MALL)\b/i;
const LOCAL = new Set(["COLUMBIA", "COL"]);
const PLAN_TYPES = { SUBD: "Subdivision plat", ANX: "Annexation", AA: "Annexation agreement", RZN: "Rezoning", PDV: "Planned development",
  CR: "Concept review", CUP: "Conditional use permit", BOA: "Board of Adjustment (variance)", HIS: "Historic preservation",
  VAC: "Right-of-way vacation", UDC: "Development code amendment" };

/* ---------------------------------------------------------------- helpers */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const KEEP_UPPER = /^(LLC|LLP|LP|INC|CO|PC|PLLC|DBA|USA|US|MO|II|III|IV|BBQ|ATM|HVAC|NE|NW|SE|SW|N|S|E|W|[A-Z]-\d+)$/;
const titleCase = (s) => (s && s === s.toUpperCase()
  ? s.toLowerCase().replace(/[a-z0-9][a-z0-9'.&-]*/g, (w) => {
      const up = w.toUpperCase().replace(/[.,]$/, "");
      if (KEEP_UPPER.test(up)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
  : s);
// Addresses mix cases ("2101 W BROADWAY STE F1"), so case each all-caps word on its own.
const fmtAddr = (s) => (s || "").replace(/\b[A-Z][A-Z'&.-]+\b/g, (w) => (KEEP_UPPER.test(w) || /^(STE|APT)$/.test(w) ? (w === "STE" ? "Ste" : w === "APT" ? "Apt" : w) : w.charAt(0) + w.slice(1).toLowerCase()));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normName = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\b(LLC|INC|CORP|CO|THE|L L C|DBA)\b/g, " ").replace(/\s+/g, " ").trim();

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url, location.href).host}`);
  return r.json();
}
async function gisQuery(layer, params) {
  const body = new URLSearchParams({ f: "json", ...params });
  return getJSON(`${layer}/query`, { method: "POST", body });
}

/* ---------------------------------------------------------------- session log (shown on Data sources) */
const log = { licenses: { read: 0, kept: 0, pages: 0, excluded: {} }, permits: { read: 0, kept: 0, pages: 0, excluded: {} },
  planning: { read: 0 }, parcels: { looked_up: 0, mapped: 0, owners_shown: 0, owners_hidden: 0, residential_hidden: 0 },
  liquor: { loaded: 0, matched: 0 } };
function addExcluded(target, ex) { for (const [k, n] of Object.entries(ex || {})) target[k] = (target[k] || 0) + n; }

/* ---------------------------------------------------------------- live fetching */
// One feed per relay search; pages are fetched newest-first until they pass the date window.
class Feed {
  constructor(kind, keyword) { this.kind = kind; this.keyword = keyword; this.rows = []; this.page = 0; this.oldest = null; this.done = false; this.total = null; }
  covers(cutoff) { return this.done || (this.oldest && new Date(this.oldest) < cutoff); }
  async fetchPage(p) {
    const q = new URLSearchParams({ kind: this.kind, page: p, size: PAGE_SIZE });
    if (this.keyword) q.set("keyword", this.keyword);
    const d = await getJSON(`${RELAY}/search?${q}`);
    if (d.error) throw new Error(d.error);
    return d;
  }
  take(d, onPage) {
    this.page = Math.max(this.page, d.page); this.total = d.total;
    if (d.oldest && (!this.oldest || d.oldest < this.oldest)) this.oldest = d.oldest;
    if (!d.has_more) this.done = true;
    this.rows.push(...d.rows);
    const l = log[this.kind]; l.pages++; l.read += d.read; l.kept += d.rows.length; addExcluded(l.excluded, d.excluded);
    return onPage(d.rows);
  }
  // City pages take ~6s each, so after the first page, estimate how many more the window needs and fetch 3 at a time.
  async extend(cutoff, onPage, token) {
    if (this.covers(cutoff)) return;
    if (this.page === 0) {
      const first = await this.fetchPage(1);
      if (token.cancelled) return;
      this.newest = first.rows[0]?.applied || new Date().toISOString();
      await this.take(first, onPage);
    }
    while (!this.covers(cutoff) && !token.cancelled) {
      const spanPerPage = (new Date(this.newest) - new Date(this.oldest)) / this.page || 864e5;
      const need = Math.ceil((new Date(this.oldest) - cutoff) / spanPerPage);
      const batch = Array.from({ length: Math.min(Math.max(need, 1), 3) }, (_, i) => this.page + 1 + i);
      const results = await Promise.all(batch.map((p) => this.fetchPage(p)));
      if (token.cancelled) return;
      for (const d of results.sort((a, b) => a.page - b.page)) await this.take(d, onPage);
    }
  }
}
const feeds = { licenses: new Feed("licenses"), commercial: new Feed("permits", "Commercial"), signs: new Feed("permits", "Sign") };

const parcels = new Map(); // parcel -> {lat,lng,owner,zoning,residential}
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
        const lat = pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null;
        const lng = pts.length ? pts.reduce((s, p) => s + p[0], 0) / pts.length : null;
        const owner = (f.attributes.OWNER1 || "").replace(/\s+/g, " ").trim();
        parcels.set(f.attributes.PARCEL, { lat, lng, owner: ENTITY.test(owner) ? owner : null, ownerHidden: !!owner && !ENTITY.test(owner), zoning: null });
        log.parcels.looked_up++;
      }
    } catch (e) { console.warn("parcel lookup failed", e); }
  }
  // Zoning, a few at a time.
  const needZoning = todo.map((p) => [p, parcels.get(p)]).filter(([, v]) => v && v.lat != null && v.zoning == null);
  for (let i = 0; i < needZoning.length; i += 8) {
    await Promise.all(needZoning.slice(i, i + 8).map(async ([, v]) => {
      try {
        const res = await gisQuery(ZONING, { geometry: `${v.lng},${v.lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
          spatialRel: "esriSpatialRelIntersects", outFields: "DISTRICT", returnGeometry: "false" });
        v.zoning = (res.features?.[0]?.attributes?.DISTRICT || "").trim();
      } catch { v.zoning = ""; }
      v.residential = /^R-|^R\d|^RMH|^PUD/i.test(v.zoning || "");
    }));
  }
  for (const r of rows) applyParcel(r);
}
function applyParcel(r) {
  const p = r.parcel ? parcels.get(r.parcel) : null;
  r.lat = r.lng = null; r.property_owner = null; r.zoning = null; r.masked = false;
  if (!p) return;
  r.zoning = p.zoning || null;
  // Licenses at residentially zoned parcels are most likely someone's home: no house number, no pin, no owner.
  if (r.license_type && p.residential) { r.masked = true; return; }
  if (r.license_type && !LOCAL.has((r.city || "").toUpperCase())) return; // based elsewhere: not a Columbia location
  r.lat = p.lat; r.lng = p.lng; r.property_owner = p.owner;
}

let liquor = null;
async function loadLiquor() {
  if (liquor) return liquor;
  const q = new URLSearchParams({ $where: "upper(city) like '%COLUMBIA%' AND upper(county) like '%BOONE%'", $limit: "5000",
    $select: "licensee,dbaname,primary_type,primary_license" });
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
  const res = await gisQuery(PLANNING, { where: `cent = 1 AND app_dat >= ${yymmdd}`, outFields: "PZ_OPTVW,ext_desc,typ_code,prj_sts,app_dat,Link,Board_Report_Link,Council_Report_Link",
    returnGeometry: "true", outSR: "4326", maxAllowableOffset: "0.0001", orderByFields: "app_dat DESC" });
  // Short-term rental permits are about private homes, so they're left out like rental licenses.
  const feats = (res.features || []).filter((f) => !/SHORT[- ]TERM RENTAL/i.test(f.attributes.ext_desc || ""));
  log.planning.skipped = (res.features || []).length - feats.length;
  planningCache = feats.map((f) => {
    const a = f.attributes; const d = String(a.app_dat || "");
    const pts = (f.geometry?.rings || []).flat();
    return {
      id: a.PZ_OPTVW, title: a.ext_desc, type: PLAN_TYPES[(a.typ_code || "").trim()] || `Other (${(a.typ_code || "").trim() || "no code"})`,
      applied: d.length === 6 ? `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}T12:00:00` : null,
      links: [["Application", a.Link], ["Board report", a.Board_Report_Link], ["Council report", a.Council_Report_Link]].filter(([, u]) => u),
      lat: pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null,
      lng: pts.length ? pts.reduce((s, p) => s + p[0], 0) / pts.length : null,
    };
  });
  log.planning.read = planningCache.length;
  return planningCache;
}

/* ---------------------------------------------------------------- shaping */
function shapeLicense(r) {
  const city = (r.city || "").toUpperCase();
  const opened = r.company_opened ? new Date(r.company_opened) : null;
  const applied = new Date(r.applied);
  r.likely_new = !opened || opened >= new Date(applied - 120 * 864e5);
  r.local = LOCAL.has(city);
  const m = (r.license_type || "").split(/\s[–-]\s/);
  r.industry_group = m.length > 1 && /^(General Business License|Home Occupation)/.test(m[0]) ? m[1].trim()
    : /^Construction/.test(r.license_type) ? "Construction" : /^Accom/.test(r.license_type) ? "Accommodation and Food Services"
    : /^Retail/.test(r.license_type) ? "Retail Trade" : /Marijuana/.test(r.license_type) ? "Cannabis" : "Other";
  const hit = liquor && (liquor.get(normName(r.dba)) || liquor.get(normName(r.company)));
  r.liquor = hit ? { type: hit.primary_type, licensee: hit.licensee } : null;
  return r;
}

/* ---------------------------------------------------------------- UI state */
const state = { tab: store.get("radar-tab") || "businesses", token: { cancelled: true }, active: null, markers: new Map(), status: "" };
const COLORS = { businesses: "#1d4ed8", buildouts: "#b45309", planning: "#7e22ce" };
const map = L.map("map", { scrollWheelZoom: false }).setView([38.9517, -92.3341], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const pin = (c) => L.divIcon({ className: "", html: `<div class="pin" style="background:${c}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });

const cutoff = () => new Date(Date.now() - Number($("days").value) * 864e5);

function currentRows() {
  const since = cutoff();
  const q = $("q").value.trim().toLowerCase();
  const group = $("group").value;
  let list;
  if (state.tab === "businesses") {
    list = feeds.licenses.rows.map(shapeLicense);
    if ($("onlyNew").checked) list = list.filter((r) => r.likely_new);
    if ($("onlyLocal").checked) list = list.filter((r) => r.local);
    if (group) list = list.filter((r) => r.industry_group === group);
  } else if (state.tab === "buildouts") {
    list = [...feeds.commercial.rows, ...feeds.signs.rows];
    if (group) list = list.filter((r) => r.permit_type === group);
  } else {
    list = planningCache || [];
    if (group) list = list.filter((r) => r.type === group);
  }
  list = list.filter((r) => r.applied && new Date(r.applied) >= since);
  if (q) list = list.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
  return list.sort((a, b) => (b.applied || "").localeCompare(a.applied || ""));
}

function groupsFor(tab) {
  const key = { businesses: "industry_group", buildouts: "permit_type", planning: "type" }[tab];
  const all = tab === "businesses" ? feeds.licenses.rows.map(shapeLicense) : tab === "buildouts" ? [...feeds.commercial.rows, ...feeds.signs.rows] : planningCache || [];
  const counts = {};
  all.filter((r) => r.applied && new Date(r.applied) >= cutoff()).forEach((r) => { counts[r[key]] = (counts[r[key]] || 0) + 1; });
  return counts;
}
function setGroups() {
  const label = { businesses: "All industries", buildouts: "All permit types", planning: "All case types" }[state.tab];
  const keep = $("group").value;
  const counts = groupsFor(state.tab);
  $("group").innerHTML = `<option value="">${label}</option>` + Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<option value="${esc(k)}">${esc(k)} (${n})</option>`).join("");
  if (counts[keep]) $("group").value = keep;
}

/* ---------------------------------------------------------------- cards */
function bizCard(r) {
  const name = titleCase(r.dba || r.company || "Unnamed business");
  const legal = r.dba && r.company && normName(r.dba) !== normName(r.company) ? titleCase(r.company) : "";
  const street = (r.address || "").replace(/^\d+\s+/, "").replace(/\s+(COLUMBIA|COL)\s+MO.*$/i, "");
  const where = r.home_based ? `Home-based business${r.city ? `, ${esc(titleCase(r.city))}` : ""}`
    : r.masked ? `Residential area on ${esc(fmtAddr(street))}`
    : esc(fmtAddr(r.address) || "No address listed");
  const lookup = encodeURIComponent(r.company || r.dba || "");
  return `
    <h3>${esc(name)}</h3>
    <p class="legal">${legal ? `${esc(legal)} · ` : ""}${esc(r.company_type || "")}</p>
    ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
    <div class="tags">
      ${r.likely_new ? '<span class="tag new">Likely new</span>' : '<span class="tag">Renewal or existing</span>'}
      ${!r.local && r.city ? `<span class="tag away">Based in ${esc(titleCase(r.city))}</span>` : ""}
      ${r.industry || r.industry_group ? `<span class="tag">${esc(r.industry || r.industry_group)}</span>` : ""}
      <span class="tag">${esc(r.status)}</span>
    </div>
    <dl class="facts">
      <dt>Applied</dt><dd>${fmtDate(r.applied)}${r.issued ? ` · issued ${fmtDate(r.issued)}` : ""}</dd>
      <dt>Location</dt><dd>${where}</dd>
      ${r.zoning && !r.masked ? `<dt>Zoning</dt><dd>${esc(r.zoning)}</dd>` : ""}
      ${r.property_owner ? `<dt>Property owner</dt><dd>${esc(titleCase(r.property_owner))}</dd>` : ""}
      ${r.liquor ? `<dt>Liquor license</dt><dd>${esc(r.liquor.type)} · ${esc(titleCase(r.liquor.licensee))}</dd>` : ""}
      <dt>License</dt><dd>${esc(r.id)} · ${esc(r.license_type)}</dd>
    </dl>
    <div class="links">
      <a href="https://opencorporates.com/companies/us_mo?q=${lookup}" target="_blank" rel="noopener">Company filings (OpenCorporates)</a>
      <a href="https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx?SearchType=0" target="_blank" rel="noopener">Missouri SOS search</a>
    </div>`;
}
function buildCard(r) {
  return `
    <h3>${esc(fmtAddr(r.address) || r.project || "Commercial project")}</h3>
    <p class="legal">${esc(r.permit_type)}${r.work_class && r.work_class !== r.permit_type ? ` · ${esc(r.work_class)}` : ""}</p>
    ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
    <div class="tags"><span class="tag">${esc(r.status)}</span>${r.zoning ? `<span class="tag">Zoned ${esc(r.zoning)}</span>` : ""}</div>
    <dl class="facts">
      <dt>Applied</dt><dd>${fmtDate(r.applied)}${r.issued ? ` · issued ${fmtDate(r.issued)}` : ""}</dd>
      ${r.property_owner ? `<dt>Property owner</dt><dd>${esc(titleCase(r.property_owner))}</dd>` : ""}
      <dt>Permit</dt><dd>${esc(r.id)}</dd>
    </dl>`;
}
function planCard(r) {
  const links = r.links.map(([t, u]) => `<a href="${esc(u.replace(/^http:/, "https:"))}" target="_blank" rel="noopener">${t} (PDF)</a>`).join("");
  return `
    <h3>${esc(titleCase(r.title) || r.id)}</h3>
    <p class="legal">${esc(r.type)} · ${esc(r.id)}</p>
    <dl class="facts"><dt>Filed</dt><dd>${fmtDate(r.applied)}</dd></dl>
    ${links ? `<div class="links">${links}</div>` : ""}`;
}

/* ---------------------------------------------------------------- render */
let fitOnce = false;
function render() {
  const list = currentRows();
  const card = { businesses: bizCard, buildouts: buildCard, planning: planCard }[state.tab];
  layer.clearLayers(); state.markers.clear();
  const bounds = [];
  const unmapped = list.filter((r) => r.lat == null).length;
  const head = `<p class="status">${esc(state.status)}${list.length ? ` ${list.length} shown${unmapped ? ` · ${unmapped} not on the map` : ""}.` : ""}</p>`;
  $("list").innerHTML = head + (list.length ? list.map((r, i) => `<article class="item" data-i="${i}">${card(r)}</article>`).join("")
    : state.loading ? "" : `<p class="empty">Nothing matches these filters.</p>`);
  list.forEach((r, i) => {
    if (r.lat == null || r.lng == null) return;
    const m = L.marker([r.lat, r.lng], { icon: pin(COLORS[state.tab]) })
      .bindTooltip(esc(titleCase(r.dba || r.company || r.title || r.address || r.id)))
      .on("click", () => focus(i, false)).addTo(layer);
    state.markers.set(i, m); bounds.push([r.lat, r.lng]);
  });
  if (bounds.length && !fitOnce) { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 }); fitOnce = !state.loading; }
  $("list").querySelectorAll(".item").forEach((el) => el.addEventListener("click", (e) => { if (!e.target.closest("a")) focus(Number(el.dataset.i), true); }));
  $("c-businesses").textContent = feeds.licenses.rows.length ? feeds.licenses.rows.map(shapeLicense).filter((r) => r.likely_new && new Date(r.applied) >= cutoff()).length : "";
  $("c-buildouts").textContent = feeds.commercial.rows.length + feeds.signs.rows.length ? currentCount("buildouts") : "";
  $("c-planning").textContent = planningCache ? currentCount("planning") : "";
}
function currentCount(tab) { const t = state.tab; state.tab = tab; const n = currentRows().length; state.tab = t; return n; }
function focus(i, fromList) {
  document.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
  const el = document.querySelector(`.item[data-i="${i}"]`);
  if (el) { el.classList.add("active"); if (!fromList) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
  const m = state.markers.get(i);
  if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openTooltip(); }
}

/* ---------------------------------------------------------------- load on demand */
async function load() {
  state.token.cancelled = true;
  const token = (state.token = { cancelled: false });
  const since = cutoff();
  state.loading = true; fitOnce = false;
  const t0 = performance.now();
  const pending = [];
  try {
    if (state.tab === "businesses") {
      await loadLiquor();
      state.status = "Asking the city for business licenses…"; render();
      await feeds.licenses.extend(since, async (rows) => {
        pending.push(enrich(rows).then(() => { setGroups(); render(); }));
        state.status = `Read ${log.licenses.read.toLocaleString()} license records back to ${fmtDate(feeds.licenses.oldest)}…`;
        setGroups(); render();
      }, token);
    } else if (state.tab === "buildouts") {
      state.status = "Asking the city for commercial and sign permits…"; render();
      for (const f of [feeds.commercial, feeds.signs]) {
        await f.extend(since, async (rows) => {
          pending.push(enrich(rows).then(() => { setGroups(); render(); }));
          state.status = `Read ${(log.permits.read).toLocaleString()} permit records…`;
          setGroups(); render();
        }, token);
      }
    } else if (state.tab === "planning") {
      state.status = "Loading planning cases…"; render();
      await loadPlanning();
    }
    await Promise.all(pending);
    if (token.cancelled) return;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    state.status = `Live from public records as of ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} (${secs}s).`;
  } catch (e) {
    if (token.cancelled) return;
    state.status = `Couldn't reach a data source (${e.message}). Try again in a minute.`;
  }
  state.loading = false;
  setGroups(); render(); renderSources();
  $("updated").textContent = `Live data · checked ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/* ---------------------------------------------------------------- data sources page */
const SOURCES = [
  { name: "Business licenses", org: "City of Columbia · EnerGov Self Service public search (via the Radar relay)", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => log.licenses.pages ? `This visit: ${log.licenses.pages} page(s), ${log.licenses.read.toLocaleString()} records read, ${log.licenses.kept.toLocaleString()} businesses kept${Object.keys(log.licenses.excluded).length ? `; left out ${Object.entries(log.licenses.excluded).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}` : ""}.` : "Not queried yet this visit. Open New businesses.",
    used: [["Company name, DBA, company type", "the business and its legal form"], ["Applied and issued dates, status", "when it applied and where it is in review"], ["License type and industry", "what kind of business it is"], ["Owner-written description", "the business describing itself"], ["Address and parcel", "where it is, with the exceptions below"], ["Company opened date", "likely new = no opened date, or opened within 120 days of applying"]],
    skipped: [["Rental and short-term rental licenses", "they describe private homes; dropped by the relay before reaching your browser"], ["License holder names and tax ID", "personal data; stripped by the relay"], ["Address of home-based businesses", "stripped by the relay"], ["House number and map pin when the parcel is zoned residential", "most likely someone's home"]] },
  { name: "Commercial and sign permits", org: "City of Columbia · EnerGov Self Service public search (via the Radar relay)", url: "https://energov.como.gov/EnerGov_Prod/SelfService#/search",
    live: () => log.permits.pages ? `This visit: ${log.permits.pages} page(s), ${log.permits.read.toLocaleString()} records read, ${log.permits.kept.toLocaleString()} kept.` : "Not queried yet this visit. Open Buildouts.",
    used: [["Permit type and work class", "commercial alteration, new commercial building, sign"], ["Work description", "often names the new use"], ["Applied and issued dates, status", "how far along it is"], ["Address and parcel", "where the work is"]],
    skipped: [["Residential, utility and trade permits", "not about businesses; the relay only asks for commercial and sign permits"], ["Contractor and applicant contacts", "people's contact details"]] },
  { name: "Planning and zoning cases", org: "City of Columbia GIS · CurrentPlanningCases (queried directly)", url: "https://gis.gocolumbiamo.com/arcgis/rest/services/CurrentPlanningCases/MapServer/0",
    live: () => log.planning.read ? `This visit: ${log.planning.read} cases filed in the last 365 days${log.planning.skipped ? `; left out ${log.planning.skipped} short-term rental permits (private homes)` : ""}.` : "Not queried yet this visit. Open Planned development.",
    used: [["Case number, title, type, filing date", "what's proposed and when"], ["Application, board and council report PDFs", "the original documents"], ["Case boundary", "shown at its center on the map"]],
    skipped: [["Short-term rental conditional use permits", "they're about private homes"], ["Ordinance and agenda numbers", "only meaningful after council action"], ["Shape area and length", "technical fields"]] },
  { name: "Parcels, property owners and zoning", org: "City of Columbia GIS · parcel layer (Boone County Assessor) and current zoning (queried directly)", url: "https://gis.gocolumbiamo.com/arcgis/rest/services/Energov/Energov_View/MapServer/0",
    live: () => log.parcels.looked_up ? `This visit: ${log.parcels.looked_up} parcels looked up.` : "Looked up as records load.",
    used: [["Parcel shape", "turned into a map point"], ["Zoning district", "what the land is zoned for"], ["Property owner when it's a company", "e.g. the LLC that owns the building"]],
    skipped: [["Property owner when it's a person", "private individuals' names are never shown"], ["Owner mailing address", "personal contact info"]] },
  { name: "Liquor licenses", org: "State of Missouri · Division of Alcohol and Tobacco Control via data.mo.gov (queried directly)", url: "https://data.mo.gov/Regulatory/Missouri-Primary-Alcohol-Licenses/d9fr-pncw",
    live: () => log.liquor.loaded ? `This visit: ${log.liquor.loaded} active Columbia liquor licenses loaded and matched to businesses by name.` : "Loaded with New businesses.",
    used: [["Licensee and DBA", "who holds the license"], ["License type", "e.g. retail by the drink"]],
    skipped: [["Managing officer's name", "an individual"], ["Phone numbers", "personal contact info"]] },
  { name: "Missouri business registrations", org: "Missouri Secretary of State and OpenCorporates", url: "https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx?SearchType=0",
    live: () => "Linked, not pulled. Each business has lookup links for its state filing (registered agent, officers, formation date).",
    used: [["Lookup links on each business", "you follow them yourself"]],
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
  $("newWrap").hidden = $("localWrap").hidden = tab !== "businesses";
  $("group").value = "";
  if (tab === "planning" && Number($("days").value) < 90) $("days").value = "90";
  setGroups(); render();
  setTimeout(() => map.invalidateSize(), 0);
  load();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
["q", "group", "onlyNew", "onlyLocal"].forEach((id) => $(id).addEventListener("input", () => { fitOnce = false; render(); }));
$("days").addEventListener("change", () => { setGroups(); load(); });
renderSources();
setTab(state.tab);
