// Where the site sends city license/permit searches.
// Local dev server serves the relay at /api; the public site uses the Cloudflare Worker.
window.RADAR_RELAY = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "/api"
  : "https://como-business-radar.andrew-jake-evans.workers.dev";
