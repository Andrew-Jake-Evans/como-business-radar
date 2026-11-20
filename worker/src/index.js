/**
 * CoMo Business Radar relay.
 *
 * The City of Columbia's EnerGov public search doesn't allow requests from other websites,
 * so this Worker relays a limited set of searches for the Radar site:
 *
 *   GET /search?kind=permits|plans|licenses|inspections[&keyword=...][&exact=1]&page=1&size=100
 *       Newest-first feed. Space-separated keywords match any of the words.
 *   GET /related?q=<address, business name or parcel number>&module=permits|plans|licenses|inspections|codecases&size=25
 *       Every record of one type that mentions an address or business, newest first.
 *
 * It builds each city request itself (it is not an open proxy), drops records about private homes
 * and individual people, strips personal fields, and caches each response for 10 minutes.
 */
import TEMPLATE from "./energov_search_template.json";

const ENERGOV = "https://energov.como.gov/EnerGov_Prod/selfservice/api/energov/search/search";
const ALLOWED_ORIGINS = [
  "https://andrew-jake-evans.github.io",
  "http://localhost:8001",
  "http://127.0.0.1:8001",
];
const CACHE_SECONDS = 600;
const MAX_PAGE = 60;
const MAX_SIZE = 100;
const KEYWORD_RE = /^[\w &'.,#/-]{2,60}$/;
// Feed searches may carry a list of words (the city's search ORs space-separated words).
const FEED_KEYWORD_RE = /^[\w &'.,#/-]{2,240}$/;

// How each EnerGov module is searched and sorted.
const MODULES = {
  permits:     { filter: 2,  crit: "PermitCriteria",     sort: "ApplyDate" },
  plans:       { filter: 3,  crit: "PlanCriteria",       sort: "ApplyDate" },
  inspections: { filter: 4,  crit: "InspectionCriteria", sort: "RequestDate" },
  codecases:   { filter: 5,  crit: "CodeCaseCriteria",   sort: "OpenedDate" },
  licenses:    { filter: 8,  crit: "LicenseCriteria",    sort: "AppliedDate", also: "BusinessLicenseCriteria" },
};

// Records about private homes or individual people, not businesses.
const EXCLUDE = [
  [(e) => /^Rental|^3 OR MORE DWELLING|^Rental - Shared/i.test(e.CaseType || ""), "Rental licenses (private homes and landlords)"],
  [(e) => /^Short-Term Rental/i.test(e.CaseType || ""), "Short-term rental licenses (private homes)"],
  [(e) => e.ModuleName === 9 || /Parking Hangtag/i.test(e.CaseType || ""), "Licenses issued to individual people"],
  [(e) => e.ModuleName === 2 && /^(Residential|Single Family|New Residential|Re-Roof|Deck Only|Solar Photovoltaic System \(Res)/i.test(e.CaseType || ""), "Residential permits (private homes)"],
  [(e) => /Animal Control|Covid 19/i.test(e.CaseType || ""), "Animal control and COVID-order records"],
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
}
function json(body, status, origin, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin), ...extra } });
}
function clean(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t || null;
}
function cleanAddress(s) {
  const t = clean(s);
  return t ? t.replace(/\bCOL MO\b/i, "COLUMBIA MO").replace(/\b(STE|APT) Unit: /i, "$1 ").replace(/\bUnit: (STE|APT|UNIT) /i, "$1 ").replace(/\bUnit: /i, "Unit ") : null;
}

// One trimmed shape per record type. Holder names, tax IDs and contact details never leave the relay.
function trim(e) {
  const base = { id: e.CaseNumber, module: e.ModuleName, type: clean(e.CaseType), work_class: clean(e.CaseWorkclass), status: clean(e.CaseStatus) };
  switch (e.ModuleName) {
    case 2: case 3:
      return { ...base, kind: e.ModuleName === 2 ? "permit" : "plan", applied: e.ApplyDate, issued: e.IssueDate, finaled: e.FinalDate || e.CompleteDate,
        project: clean(e.ProjectName), description: clean(e.Description), address: cleanAddress(e.AddressDisplay), parcel: e.MainParcel || null };
    case 4:
      return { ...base, kind: "inspection", applied: e.RequestDate || e.ScheduleDate, scheduled: e.ScheduleDate, address: cleanAddress(e.AddressDisplay), parcel: e.MainParcel || null };
    case 5:
      // Code cases can be complaints about people: type, status and dates only.
      return { ...base, kind: "code case", applied: e.OpenedDate || e.ApplyDate, closed: e.ClosedDate, address: cleanAddress(e.AddressDisplay), parcel: e.MainParcel || null };
    case 8: {
      const home = /^Home Occupation/i.test(e.CaseType || "");
      return { ...base, kind: "license", license_type: clean(e.CaseType), applied: e.ApplyDate, issued: e.IssueDate,
        company: clean(e.CompanyName), dba: clean(e.DBA), company_type: clean(e.CompanyTypeName), industry: clean(e.BusinessTypeName),
        description: clean(e.Description), company_opened: e.OpenedDate, city: clean(e.Address?.City), home_based: home,
        address: home ? null : cleanAddress(e.AddressDisplay), parcel: home ? null : e.MainParcel || null };
    }
    default:
      return null;
  }
}

async function cityQuery(moduleKey, { keyword = "", exact = false, page = 1, size = 100 }) {
  const m = MODULES[moduleKey];
  const body = structuredClone(TEMPLATE);
  Object.assign(body, { Keyword: keyword, ExactMatch: exact, FilterModule: m.filter, SortBy: m.sort, SortAscending: false, PageNumber: page, PageSize: size });
  body[m.crit].SortBy = m.sort;
  if (m.also) body[m.also].SortBy = m.sort;
  const res = await fetch(ENERGOV, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", Accept: "application/json", tenantId: "1", tenantName: "EnerGovProd",
      "Tyler-TenantUrl": "EnerGovProd", "Tyler-Tenant-Culture": "en-US",
      "User-Agent": "como-business-radar-relay/1.1 (github.com/Andrew-Jake-Evans/como-business-radar)" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`City search returned ${res.status}`);
  const data = await res.json();
  if (!data.Success || !data.Result) throw new Error("City search failed");
  const raw = data.Result.EntityResults || [];
  const excluded = {};
  const rows = [];
  for (const e of raw) {
    const hit = EXCLUDE.find(([test]) => test(e));
    if (hit) { excluded[hit[1]] = (excluded[hit[1]] || 0) + 1; continue; }
    const t = trim(e);
    if (t) rows.push(t);
  }
  const r = data.Result;
  const total = { permits: r.PermitsFound, plans: r.PlansFound, inspections: r.InspectionsFound, codecases: r.CodeCasesFound, licenses: r.LicensesFound }[moduleKey] ?? r.TotalFound;
  const dateOf = (e) => e.ApplyDate || e.RequestDate || e.ScheduleDate || e.OpenedDate;
  return { total, read: raw.length, has_more: page * size < total && raw.length === size, oldest: raw.length ? dateOf(raw[raw.length - 1]) : null, rows, excluded };
}

async function handle(url) {
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "");
  const p = url.searchParams;
  const page = Math.min(Math.max(parseInt(p.get("page") || "1", 10) || 1, 1), MAX_PAGE);
  const size = Math.min(Math.max(parseInt(p.get("size") || "100", 10) || 100, 10), MAX_SIZE);
  if (path === "/search") {
    const kind = p.get("kind");
    const keyword = (p.get("keyword") || "").trim();
    if (!["permits", "plans", "licenses", "inspections"].includes(kind)) return [400, { error: "kind must be permits, plans, licenses or inspections" }];
    if (kind === "inspections" && !keyword) return [400, { error: "inspection feeds need a keyword" }];
    if (keyword && !FEED_KEYWORD_RE.test(keyword)) return [400, { error: "keyword must be 2-240 letters, numbers or simple punctuation" }];
    const exact = p.get("exact") === "1";
    const out = await cityQuery(kind, { keyword, exact, page, size });
    return [200, { kind, keyword: keyword || null, page, size, ...out, fetched_at: new Date().toISOString() }];
  }
  if (path === "/related") {
    const q = (p.get("q") || "").trim();
    const module = p.get("module");
    if (!MODULES[module]) return [400, { error: "module must be permits, plans, licenses, inspections or codecases" }];
    if (!KEYWORD_RE.test(q)) return [400, { error: "q must be 2-60 letters, numbers or simple punctuation" }];
    const out = await cityQuery(module, { keyword: q, exact: true, page: 1, size: Math.min(size, 50) });
    return [200, { q, module, ...out, fetched_at: new Date().toISOString() }];
  }
  return [200, { ok: true, usage: ["/search?kind=permits|plans|licenses|inspections&keyword=restaurant cafe&page=1&size=100", "/related?q=2101 W BROADWAY&module=permits|plans|licenses|inspections|codecases"] }];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "GET") return json({ error: "GET only" }, 405, origin);

    // Normalized cache key so identical searches share one city request.
    const keyParams = [...url.searchParams.entries()].sort().map(([k, v]) => `${k}=${encodeURIComponent(v.trim().toLowerCase())}`).join("&");
    const cacheKey = new Request(`https://radar-cache${url.pathname.replace(/^\/api/, "")}?${keyParams}`);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return json(await hit.text(), 200, origin, { "X-Radar-Cache": "hit" });
    }
    try {
      const [status, result] = await handle(url);
      const body = JSON.stringify(result);
      if (cache && status === 200) {
        ctx?.waitUntil?.(cache.put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } })));
      }
      return json(body, status, origin, { "X-Radar-Cache": "miss" });
    } catch (err) {
      return json({ error: String(err.message || err) }, 502, origin);
    }
  },
};
