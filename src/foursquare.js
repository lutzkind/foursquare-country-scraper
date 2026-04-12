const { bboxCenter, bboxRadiusMeters, pointInsideBBox, pointInsideGeometry } = require("./geo");

const SEARCH_URL = "https://api.foursquare.com/v3/places/search";
const MAX_RADIUS_METERS = 100000;
const PAGE_LIMIT = 50;

let foursquareThrottle = Promise.resolve();

function queueFoursquareRequest(task, delayMs) {
  foursquareThrottle = foursquareThrottle
    .then(() => new Promise((resolve) => setTimeout(resolve, delayMs)))
    .then(task);
  return foursquareThrottle;
}

async function resolveCountry(countryName, config) {
  const url = `${config.nominatimUrl}?q=${encodeURIComponent(countryName)}&format=json&limit=1&addressdetails=1&polygon_geojson=1`;
  const response = await fetch(url, {
    headers: { "User-Agent": config.userAgent },
  });
  if (!response.ok) throw new Error(`Nominatim error: ${response.status}`);
  const results = await response.json();
  if (!results.length) throw new Error(`Country not found: ${countryName}`);
  const result = results[0];
  const bbox = {
    south: parseFloat(result.boundingbox[0]),
    north: parseFloat(result.boundingbox[1]),
    west: parseFloat(result.boundingbox[2]),
    east: parseFloat(result.boundingbox[3]),
  };
  return {
    displayName: result.display_name,
    countryCode: result.address?.country_code?.toUpperCase() || "",
    bbox,
    geometry: result.geojson || null,
  };
}

async function queryFoursquare({ job, shard, geometry, config }) {
  const center = bboxCenter(shard.bbox);
  const radiusMeters = Math.min(Math.round(bboxRadiusMeters(shard.bbox) / 2), MAX_RADIUS_METERS);
  const query = job.searchParams?.query || job.keyword;

  const raw = await queueFoursquareRequest(async () => {
    const params = new URLSearchParams({
      ll: `${center.lat},${center.lon}`,
      radius: String(radiusMeters),
      limit: String(PAGE_LIMIT),
      fields: "fsq_id,name,categories,geocodes,location,tel,website,rating,stats,price,closed_bucket",
    });
    if (query) params.set("query", query);

    const response = await fetch(`${SEARCH_URL}?${params}`, {
      headers: {
        Accept: "application/json",
        Authorization: config.foursquareApiKey,
      },
      signal: AbortSignal.timeout(config.foursquareTimeoutMs),
    });

    // Capture credit headers before consuming the body
    const remainingCredits = parseRateLimitHeader(response);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err = new Error(`Foursquare error ${response.status}: ${text.slice(0, 200)}`);
      err.statusCode = response.status;
      err.remainingCredits = remainingCredits;
      throw err;
    }

    const data = await response.json();
    return { results: data.results || [], remainingCredits };
  }, config.foursquareDelayMs);

  const rawCount = raw.results.length;
  const remainingCredits = raw.remainingCredits;

  const leads = raw.results
    .map((b) => normalizeEntry(b, shard.bbox))
    .filter((lead) => {
      if (!Number.isFinite(lead.lat) || !Number.isFinite(lead.lon)) return false;
      if (!pointInsideBBox(lead.lat, lead.lon, shard.bbox)) return false;
      if (geometry && !pointInsideGeometry(lead.lat, lead.lon, geometry)) return false;
      return true;
    });

  return { rawCount, leads, remainingCredits };
}

function parseRateLimitHeader(response) {
  // Foursquare v3 uses X-RateLimit-Remaining; fall back to the IETF draft header
  for (const name of ["X-RateLimit-Remaining", "RateLimit-Remaining", "x-ratelimit-remaining"]) {
    const value = response.headers.get(name);
    if (value != null) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return -1; // header not present
}

function normalizeEntry(place, bbox) {
  const mainGeo = place.geocodes?.main || {};
  const lat = mainGeo.latitude;
  const lon = mainGeo.longitude;
  const location = place.location || {};
  const categories = (place.categories || []).map((c) => c.name).filter(Boolean);
  const primaryCategory = categories[0] || "";
  const parts = extractLocationParts(place);

  return {
    dedupeKey: place.fsq_id,
    placeId: place.fsq_id,
    cid: null,
    dataId: null,
    link: `https://foursquare.com/v/${place.fsq_id}`,
    name: place.name || "",
    category: primaryCategory,
    categories,
    website: place.website || null,
    phone: place.tel || null,
    email: null,
    address: location.formatted_address || null,
    completeAddress: location,
    city: parts.city,
    area: parts.area,
    stateRegion: parts.stateRegion,
    postcode: parts.postcode,
    country: parts.country,
    lat,
    lon,
    reviewCount: place.stats?.total_ratings || 0,
    reviewRating: place.rating != null ? Math.round((place.rating / 2) * 10) / 10 : null,
    status:
      place.closed_bucket === "VeryLikelyClosed" || place.closed_bucket === "LikelyClosed"
        ? "CLOSED"
        : "OPERATIONAL",
    priceRange: place.price ? "$".repeat(place.price) : null,
    bbox,
    raw: place,
  };
}

function extractLocationParts(place) {
  const loc = place.location || {};
  return {
    city: loc.locality || loc.post_town || "",
    area: loc.neighborhood || loc.cross_street || "",
    stateRegion: loc.region || loc.administrative_area || "",
    postcode: loc.postcode || "",
    country: loc.country || "",
  };
}

module.exports = { resolveCountry, queryFoursquare, normalizeEntry, extractLocationParts };
