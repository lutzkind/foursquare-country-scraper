# Foursquare Country Scraper

Country-scale place-harvesting service that shards a geography, queries the Foursquare Places API, and produces resumable lead datasets with exports and optional NocoDB sync.

## Language

**Job**:
One country-plus-keyword collection run.
_Avoid_: Crawl, import

**Shard**:
A geographic work unit derived from the country boundary and processed independently.
_Avoid_: Tile, page

**Lead**:
A normalized place record produced from Foursquare search results.
_Avoid_: Result row, business object

**Split threshold**:
The result-count cutoff that forces a **Shard** to divide into children.
_Avoid_: Overflow, max page rule

**Credit floor**:
The remaining API-credit level at which the scraper pauses for quota safety.
_Avoid_: Limit reached, billing stop

**NocoDB sync**:
The export path that pushes normalized **Lead** data into a target NocoDB table.
_Avoid_: Backup, mirror

## Relationships

- A **Job** owns many **Shards**.
- A **Shard** can split into child **Shards** when the **Split threshold** is hit.
- A **Job** accumulates normalized **Leads** across all terminal **Shards**.
- The **Credit floor** can pause a **Job** even if unfinished **Shards** remain.
- **NocoDB sync** acts on finished or accumulated **Lead** data, not raw API payloads alone.

## Example dialogue

> **Dev:** "Why did this country run stop overnight?"
> **Domain expert:** "Check whether the **Credit floor** paused the **Job** or whether dense **Shards** kept splitting at the **Split threshold**."

## Flagged ambiguities

- "result" could mean API payloads or normalized database rows — resolved: use **Lead** for persisted output and "API response" for raw Foursquare data.
