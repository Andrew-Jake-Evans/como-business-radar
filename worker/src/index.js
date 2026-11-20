/**
 * CoMo Business Radar relay.
 *
 * The City of Columbia's EnerGov public search doesn't allow requests from other websites,
 * so this Worker relays a small, fixed set of searches for the Radar site:
 *
 *   GET /search?kind=licenses&page=1&size=100
 *   GET /search?kind=permits&keyword=Commercial|Sign&page=1&size=100
 *
 * It builds the city request itself (it is not an open proxy), keeps only business records,
 * strips personal fields, and caches each page for 10 minutes.
 */
import TEMPLATE from "./energov_search_template.json";

const ENERGOV = "https://energov.como.gov/EnerGov_Prod/selfservice/api/energov/search/search";
const ALLOWED_ORIGINS = [
  "https://andrew-jake-evans.github.io",
  "http://localhost:8001",
  "http://127.0.0.1:8001",
];
const PERMIT_KEYWORDS = ["Commercial", "Sign"];
const CACHE_SECONDS = 600;
const MAX_PAGE = 60;
const MAX_SIZE = 100;

// License types that describe private homes or individual people, not businesses.
const EXCLUDE_LICENSE = [
  [/^Rental|^3 OR MORE DWELLING/i, "Rental licenses (private homes and landlords)"],
  [/^Short-Term Rental/i, "Short-term rental licenses (private homes)"],
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin), ...extra },
  });
}

function clean(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t || null;
}

function cleanAddress(s) {
  const t = clean(s);
  return t ? t.replace(/\bCOL MO\b/i, "COLUMBIA MO").replace(/\bUnit: (STE|APT|UNIT) /i, "$1 ").replace(/\bSTE Unit: /i, "STE ") : null;
}

function trimLicense(e) {
  const home = /^Home Occupation/i.test(e.CaseType || "");
  return {
    id: e.CaseNumber,
    license_type: clean(e.CaseType),
    work_class: clean(e.CaseWorkclass),
    status: clean(e.CaseStatus),
    applied: e.ApplyDate,
    issued: e.IssueDate,
    company: clean(e.CompanyName),
    dba: clean(e.DBA),
    company_type: clean(e.CompanyTypeName),
    industry: clean(e.BusinessTypeName),
    description: clean(e.Description),
    company_opened: e.OpenedDate,
    city: clean(e.Address?.City),
    home_based: home,
    // Home-based businesses are someone's home: no street address or parcel.
    address: home ? null : cleanAddress(e.AddressDisplay),
    parcel: home ? null : e.MainParcel || null,
  };
}

function trimPermit(e) {
  return {
    id: e.CaseNumber,
    permit_type: clean(e.CaseType),
    work_class: clean(e.CaseWorkclass),
    status: clean(e.CaseStatus),
    applied: e.ApplyDate,
    issued: e.IssueDate,
    project: clean(e.ProjectName),
    description: clean(e.Description),
    address: cleanAddress(e.AddressDisplay),
    parcel: e.MainParcel || null,
  };
}

async function search(kind, keyword, page, size) {
  const body = structuredClone(TEMPLATE);
  if (kind === "licenses") {
    Object.assign(body, { FilterModule: 8, SortBy: "AppliedDate" });
    body.BusinessLicenseCriteria.SortBy = "AppliedDate";
    body.LicenseCriteria.SortBy = "AppliedDate";
  } else {
    Object.assign(body, { FilterModule: 2, SortBy: "ApplyDate", Keyword: keyword, ExactMatch: keyword === "Sign" });
    body.PermitCriteria.SortBy = "ApplyDate";
  }
  Object.assign(body, { PageNumber: page, PageSize: size, SortAscending: false });

  const res = await fetch(ENERGOV, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Accept: "application/json",
      tenantId: "1",
      tenantName: "EnerGovProd",
      "Tyler-TenantUrl": "EnerGovProd",
      "Tyler-Tenant-Culture": "en-US",
      "User-Agent": "como-business-radar-relay/1.0 (github.com/Andrew-Jake-Evans/como-business-radar)",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`City search returned ${res.status}`);
  const data = await res.json();
  if (!data.Success || !data.Result) throw new Error("City search failed");

  const raw = data.Result.EntityResults || [];
  const excluded = {};
  const rows = [];
  for (const e of raw) {
    if (kind === "licenses") {
      const hit = EXCLUDE_LICENSE.find(([re]) => re.test(e.CaseType || ""));
      if (hit) { excluded[hit[1]] = (excluded[hit[1]] || 0) + 1; continue; }
      if (e.ModuleName !== 8) { excluded["Licenses issued to individual people"] = (excluded["Licenses issued to individual people"] || 0) + 1; continue; }
      rows.push(trimLicense(e));
    } else {
      const type = e.CaseType || "";
      const wanted = keyword === "Sign" ? type === "Sign" : /Commercial/i.test(type);
      if (!wanted) { excluded["Other permit types matching the keyword"] = (excluded["Other permit types matching the keyword"] || 0) + 1; continue; }
      rows.push(trimPermit(e));
    }
  }
  const total = kind === "licenses" ? data.Result.TotalFound : data.Result.PermitsFound;
  return {
    kind, keyword: keyword || null, page, size, total,
    has_more: page * size < total && raw.length === size,
    oldest: raw.length ? raw[raw.length - 1].ApplyDate : null,
    read: raw.length, rows, excluded,
    fetched_at: new Date().toISOString(),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "GET") return json({ error: "GET only" }, 405, origin);
    if (url.pathname.replace(/\/+$/, "") !== "/search" && url.pathname !== "/api/search") {
      return json({ ok: true, usage: "/search?kind=licenses|permits&keyword=Commercial|Sign&page=1&size=100" }, 200, origin);
    }

    const kind = url.searchParams.get("kind");
    const keyword = url.searchParams.get("keyword") || "";
    const page = Math.min(Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), MAX_PAGE);
    const size = Math.min(Math.max(parseInt(url.searchParams.get("size") || "100", 10) || 100, 10), MAX_SIZE);
    if (!["licenses", "permits"].includes(kind)) return json({ error: "kind must be licenses or permits" }, 400, origin);
    if (kind === "permits" && !PERMIT_KEYWORDS.includes(keyword)) return json({ error: "keyword must be Commercial or Sign" }, 400, origin);

    // Normalized cache key so identical searches share one city request.
    const cacheKey = new Request(`https://radar-cache/search?kind=${kind}&keyword=${keyword}&page=${page}&size=${size}`);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return new Response(body, { headers: { "Content-Type": "application/json", ...cors(origin), "X-Radar-Cache": "hit" } });
      }
    }
    try {
      const result = await search(kind, keyword, page, size);
      const body = JSON.stringify(result);
      if (cache) {
        const toCache = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } });
        ctx?.waitUntil?.(cache.put(cacheKey, toCache));
      }
      return new Response(body, { headers: { "Content-Type": "application/json", ...cors(origin), "X-Radar-Cache": "miss" } });
    } catch (err) {
      return json({ error: String(err.message || err) }, 502, origin);
    }
  },
};
