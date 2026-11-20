# CoMo Food Radar

**Live:** https://andrew-jake-evans.github.io/como-business-radar/

Spots restaurants and food businesses on the way in Columbia, Missouri. Each visit searches the city's permits, plans, business licenses and inspections, plus planning cases, for any hint of food-related work, then groups what it finds by place and shows how far along each one is: **planning → construction → licensing → inspections → signage**.

- **One search per record type:** the city's search treats space-separated words as "any of", so the whole food vocabulary (restaurant, cafe, coffee, bakery, brewery, pizza, taco, catering, grease…) costs one request per record type. Matches that aren't really about food (a school kitchen) are filtered out.
- **Places, not records:** a tenant finish, kitchen hood permit, food inspection and sign at the same unit become one place with a stage tracker.
- **Something new vs. routine:** places with only routine food inspections or license renewals are hidden unless you ask for them.
- **Related records:** drill into a place to see every permit, plan, license, inspection and code case at the address (with an only-this-unit filter), other filings at the same property owner's other properties, and the business's other licenses.
- **Street View and Google Maps** links open in a new tab.
- **Data sources:** every source, what was read during your visit, and which fields are shown or deliberately left out.

## How it works

```
Browser ──► Cloudflare Worker relay ──► City EnerGov public search   (permits, plans, licenses, inspections)
   │
   ├──────► City of Columbia ArcGIS ──► parcels, owners, zoning, planning cases
   └──────► data.mo.gov ──────────────► liquor licenses
```

- **Site** (`index.html`, `app.js`, `styles.css`): plain HTML/CSS/JS with Leaflet, hosted on GitHub Pages. It pages through results newest-first until it reaches your time window, fetching a few pages at a time and showing results as they arrive.
- **Relay** (`worker/`): the city's EnerGov search blocks requests from other websites, so a small Cloudflare Worker relays two kinds of search: newest-first feeds (permits, plans, licenses, inspections, with keywords) and related-record lookups by address, business name or parcel number. It builds the city request itself (it is not an open proxy), keeps only business records, strips personal fields and caches each page for 10 minutes.
- **Local twin** (`scripts/dev_server.mjs`): serves the site and runs the same relay code at `/api`, so everything works on your machine with no accounts.

## Privacy choices

The Radar sticks to businesses. The relay drops rental and short-term rental licenses and licenses issued to individual people, and strips holder names, tax IDs and home-based business addresses before anything reaches the browser. The site hides the house number and map pin when a license's parcel is zoned residential, and shows a property owner only when the owner is a company.

## Run locally

```bash
node scripts/dev_server.mjs
```

Then open http://localhost:8001.

## Deploy the relay

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

The relay is live at https://como-business-radar.andrew-jake-evans.workers.dev (its address is set in `config.js`).

Not affiliated with the City of Columbia or the State of Missouri. Built by [Andrew Evans](https://andrew-jake-evans.github.io) with AI assistance.
