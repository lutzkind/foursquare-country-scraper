const fs = require("fs");
const path = require("path");

const BATCH_SIZE = 1000;

function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) {
    return new Promise((resolve, reject) => {
      stream.once("drain", resolve);
      stream.once("error", reject);
    });
  }
  return Promise.resolve();
}

async function closeStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    stream.once("error", reject);
  });
}

function mapLead(job, lead) {
  return {
    queryName: job?.keyword || "",
    source: lead.source || "foursquare",
    country: job?.country || "",
    city: lead.city,
    area: lead.area,
    stateRegion: lead.stateRegion,
    postcode: lead.postcode,
    leadCountry: lead.country,
    name: lead.name,
    category: lead.category,
    subcategory: lead.subcategory,
    allSubcategories: Array.isArray(lead.allSubcategories)
      ? lead.allSubcategories.join(" | ") : "",
    website: lead.website,
    phone: lead.phone,
    address: lead.address,
    reviewCount: lead.reviewCount,
    reviewRating: lead.reviewRating,
    status: lead.status,
    priceRange: lead.priceRange,
    foursquareId: lead.placeId,
    foursquareUrl: lead.link,
  };
}

function toCsvLine(row) {
  return [
    row.queryName,
    row.source,
    row.country,
    row.city,
    row.area,
    row.stateRegion,
    row.postcode,
    row.leadCountry,
    row.name,
    row.category,
    row.subcategory,
    row.allSubcategories,
    row.website,
    row.phone,
    row.address,
    row.reviewCount,
    row.reviewRating,
    row.status,
    row.priceRange,
    row.foursquareId,
    row.foursquareUrl,
  ]
    .map(escapeCsv)
    .join(",");
}

async function writeArtifacts(store, config, jobId) {
  const job = store.getJob(jobId);
  const targetDir = path.join(config.exportsDir, jobId);
  fs.mkdirSync(targetDir, { recursive: true });

  const csvPath = path.join(targetDir, "leads.csv");
  const jsonPath = path.join(targetDir, "leads.json");

  const headers = [
    "query_name", "source", "country", "city", "area", "state_region",
    "postcode", "lead_country", "name", "category", "subcategory",
    "all_subcategories", "website", "phone", "address", "review_count",
    "review_rating", "status", "price_range", "foursquare_id", "foursquare_url",
  ];

  const csvStream = fs.createWriteStream(csvPath, { encoding: "utf8" });
  const jsonStream = fs.createWriteStream(jsonPath, { encoding: "utf8" });

  try {
    await writeChunk(csvStream, `${headers.join(",")}\n`);
    await writeChunk(jsonStream, "[\n");

    let offset = 0;
    let firstJsonRow = true;

    while (true) {
      const leads = store.getJobLeads(jobId, { limit: BATCH_SIZE, offset });
      if (!leads.length) {
        break;
      }

      const rows = leads.map((lead) => mapLead(job, lead));
      await writeChunk(csvStream, `${rows.map(toCsvLine).join("\n")}\n`);

      for (const row of rows) {
        const prefix = firstJsonRow ? "" : ",\n";
        await writeChunk(jsonStream, `${prefix}${JSON.stringify(row)}`);
        firstJsonRow = false;
      }

      offset += leads.length;
      if (leads.length < BATCH_SIZE) {
        break;
      }
    }

    await writeChunk(jsonStream, "\n]\n");
  } finally {
    await Promise.all([closeStream(csvStream), closeStream(jsonStream)]);
  }

  return { csvPath, jsonPath };
}

module.exports = { writeArtifacts };
