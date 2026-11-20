# CoMo Business Radar

**Live:** https://andrew-jake-evans.github.io/como-business-radar/

A map and feed of what's opening, being built out and planned in Columbia, Missouri. Nothing is stored ahead of time: when you pick a time window, the Radar asks the city and state for just those records, live.

- **New businesses:** city business license applications, with a "likely new" flag that separates first-time businesses from renewals, plus zoning, the building's owner (when it's a company) and any state liquor license.
- **Buildouts:** commercial alteration, new-building and sign permits, which often show a business moving into a space before it opens.
- **Planned development:** rezonings, plats, annexations and concept reviews filed with the city, with links to the original applications.
- **Data sources:** every source, what was read during your visit, and which fields are shown or deliberately left out.

## How it works

```
Browser ──► Cloudflare Worker relay ──► City EnerGov public search   (licenses, permits)
   │
   ├──────► City of Columbia ArcGIS ──► parcels, zoning, planning cases
   └──────► data.mo.gov ──────────────► liquor licenses
```

- **Site** (`index.html`, `app.js`, `styles.css`): plain HTML/CSS/JS with Leaflet, hosted on GitHub Pages. It pages through results newest-first until it reaches your time window, fetching a few pages at a time and showing results as they arrive.
- **Relay** (`worker/`): the city's EnerGov search blocks requests from other websites, so a small Cloudflare Worker relays a fixed set of searches. It builds the city request itself (it is not an open proxy), keeps only business records, strips personal fields and caches each page for 10 minutes.
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
