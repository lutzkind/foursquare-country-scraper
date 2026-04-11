function normalizeKeyword(keyword) {
  return String(keyword || "").trim().toLowerCase();
}

function resolveSearchParams(keyword) {
  return { query: normalizeKeyword(keyword) };
}

module.exports = { normalizeKeyword, resolveSearchParams };
