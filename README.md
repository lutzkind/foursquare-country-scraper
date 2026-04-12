# foursquare-country-scraper

Country-scale place scraper powered by the [Foursquare Places API v3](https://docs.foursquare.com/developer/reference/place-search). Splits a country bounding box into a quadtree of shards, queries each shard at its centroid with a configurable radius, and recursively splits shards that hit the 50-result cap.

Architecture mirrors [gmaps-country-scraper](https://github.com/lutzkind/gmaps-country-scraper) and [osm-country-scraper](https://github.com/lutzkind/osm-country-scraper).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `FOURSQUARE_API_KEY` | Yes | — | Foursquare Places API key |
| `ADMIN_USERNAME` | Yes | — | Dashboard login username |
| `ADMIN_PASSWORD` | Yes | — | Dashboard login password |
| `DATA_DIR` | No | `/data` | Persistent data directory |
| `PORT` | No | `3000` | HTTP port |
| `FOURSQUARE_DELAY_MS` | No | `200` | Delay between API requests (ms) |
| `FOURSQUARE_TIMEOUT_MS` | No | `30000` | Request timeout (ms) |
| `FOURSQUARE_TARGET_SHARD_RADIUS_METERS` | No | `15000` | Target shard radius; shards larger than this are split |
| `RESULT_SPLIT_THRESHOLD` | No | `50` | Split a shard when result count hits this (Foursquare max is 50) |

## Running with Docker

```bash
docker run -d \
  -e FOURSQUARE_API_KEY=your_key \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  -v /data/foursquare:/data \
  -p 3000:3000 \
  ghcr.io/lutzkind/foursquare-country-scraper
```

## API

- `POST /jobs` — create a job `{ country, keyword }`
- `GET /jobs` — list all jobs
- `GET /jobs/:id` — job detail + stats
- `GET /jobs/:id/leads` — paginated leads
- `GET /jobs/:id/shards` — shard list (filterable by `?status=`)
- `GET /jobs/:id/errors` — recent shard errors
- `GET /jobs/:id/export/csv` — CSV export
- `GET /jobs/:id/export/json` — JSON export
- `POST /jobs/:id/pause` / `resume` / `cancel`
- `PUT /integrations/nocodb` — save NocoDB config
- `POST /jobs/:id/sync/nocodb` — sync leads to NocoDB

## NocoDB sync

Syncs leads with fields: `foursquare_id`, `foursquare_url`, `name`, `category`, `subcategory`, `all_subcategories`, `website`, `phone`, `address`, `city`, `area`, `state_region`, `postcode`, `lead_country`, `review_count`, `review_rating`, `business_status`, `price_range`, `raw_json`.
