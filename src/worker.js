const crypto = require("crypto");
const { bboxIntersectsGeometry, bboxRadiusMeters, splitBBox, canSplitBBox } = require("./geo");
const { resolveCountry, queryFoursquare } = require("./foursquare");
const { writeArtifacts } = require("./exporters");

function createWorker({ store, config, nocoDb = null }) {
  let timer = null;
  let busy = false;

  return {
    async start() {
      recoverStaleRunningShards();
      await bootstrapPendingJobs();
      timer = setInterval(() => {
        this.tick().catch((error) => console.error("Worker tick failed:", error));
      }, config.workerPollMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    async tick() {
      if (busy) return;
      busy = true;
      try {
        recoverStaleRunningShards();
        await bootstrapPendingJobs();

        // Refuse to process shards when credits are critically low
        if (creditsExhausted()) return;

        const shard = store.claimNextShard();
        if (!shard) { await maybeSyncRunningJobs(); return; }
        const job = store.getJob(shard.jobId);
        if (!job || job.status !== "running") return;
        const geometry = job.countryGeometry
          ? { type: "Feature", geometry: job.countryGeometry }
          : null;
        await processShard(job, shard, geometry);
        await maybeSyncRunningJobs();
        await maybeFinalizeJob(job.id);
      } finally {
        busy = false;
      }
    },
  };

  // Returns true if saved remaining credits are below the configured floor.
  function creditsExhausted() {
    const remaining = store.getAppSetting("foursquare.remainingCredits", -1);
    if (remaining < 0) return false; // never seen a header yet — allow through
    return remaining < config.foursquareMinCreditsRemaining;
  }

  // Called after every successful or failed API response that includes a credit count.
  function applyRemainingCredits(remainingCredits) {
    if (!Number.isFinite(remainingCredits) || remainingCredits < 0) return;
    store.setAppSettings({ "foursquare.remainingCredits": remainingCredits });
    if (remainingCredits < config.foursquareMinCreditsRemaining) {
      console.warn(
        `[credit-guard] Foursquare credits critically low: ${remainingCredits} remaining ` +
        `(floor: ${config.foursquareMinCreditsRemaining}). Pausing all running jobs.`
      );
      for (const job of store.listJobs().filter((j) => j.status === "running")) {
        store.pauseJob(job.id);
        console.warn(`[credit-guard] Paused job ${job.id} (${job.country} / ${job.keyword}).`);
      }
    }
  }

  async function bootstrapPendingJobs() {
    const jobs = store.listJobs().filter((j) => j.status === "pending");
    for (const job of jobs) {
      try {
        if (job.totalShards > 0 || job.startedAt) { store.resumeJob(job.id); continue; }
        const countryData = await resolveCountry(job.country, config);
        store.seedJob(job.id, countryData);
      } catch (error) {
        store.failJob(job.id, error.message);
      }
    }
  }

  async function processShard(job, shard, geometry) {
    if (geometry?.geometry && !bboxIntersectsGeometry(shard.bbox, geometry)) {
      store.skipShard(shard.id, "Shard does not intersect the country geometry.", shard.runToken);
      return;
    }

    const canSplit = shard.depth < config.maxShardDepth && canSplitBBox(shard.bbox, config);

    // Pre-split oversized shards before querying
    if (canSplit && bboxRadiusMeters(shard.bbox) > config.foursquareTargetShardRadiusMeters) {
      store.splitShard(shard.id, splitBBox(shard.bbox), shard.runToken);
      return;
    }

    try {
      const response = await queryFoursquare({ job, shard, geometry, config });

      // Update credit tracking after every successful call
      applyRemainingCredits(response.remainingCredits);

      if (store.getJob(job.id)?.status === "canceled") return;

      // If we just triggered a pause via applyRemainingCredits, the job is now paused —
      // don't process the shard result, release it back to retry.
      if (creditsExhausted()) {
        store.retryShard(shard.id, "Paused: Foursquare credits below minimum threshold.", 60_000, shard.runToken);
        return;
      }

      // Foursquare caps at 50 results per request with no pagination.
      // If we hit the cap and can still split, do so to get better coverage.
      if (response.rawCount >= config.resultSplitThreshold && canSplit) {
        store.splitShard(shard.id, splitBBox(shard.bbox), shard.runToken);
        return;
      }

      // At a leaf shard or below threshold — save what we have.
      store.completeShard(shard.id, response.leads, shard.runToken);
    } catch (error) {
      // Credits may arrive even on error responses
      if (Number.isFinite(error.remainingCredits)) {
        applyRemainingCredits(error.remainingCredits);
      }

      const isRateOrTimeout =
        error.name === "AbortError" ||
        error.statusCode === 429 ||
        error.statusCode === 503 ||
        error.statusCode === 504 ||
        /timeout|rate.limit|blocked/i.test(error.message);

      if (store.getJob(job.id)?.status === "canceled") return;

      if (isRateOrTimeout && canSplit && shard.attemptCount >= 2) {
        store.splitShard(shard.id, splitBBox(shard.bbox), shard.runToken);
        return;
      }
      if (shard.attemptCount < config.retryLimit) {
        const delay = config.retryBaseDelayMs * 2 ** (shard.attemptCount - 1);
        store.retryShard(shard.id, error.message, delay, shard.runToken);
        return;
      }
      if (canSplit) {
        store.splitShard(shard.id, splitBBox(shard.bbox), shard.runToken);
        return;
      }
      store.failShard(shard.id, error.message, shard.runToken);
    }
  }

  async function maybeFinalizeJob(jobId) {
    const unfinished = store.refreshJobStats(jobId);
    if (unfinished > 0) return;
    const job = store.getJob(jobId);
    if (!job || ["completed", "partial", "failed", "canceled"].includes(job.status)) return;
    if (job.leadCount === 0 && job.failedShards === job.totalShards) {
      store.finalizeJob(jobId, "failed", "All shards failed.");
      return;
    }
    const artifacts = writeArtifacts(store, config, jobId);
    const status = job.failedShards > 0 ? "partial" : "completed";
    const message = status === "completed" ? "Completed successfully." : "Completed with failed shards.";
    store.finalizeJob(jobId, status, message, artifacts);
    if (nocoDb) await nocoDb.syncCompletedJobIfEnabled(jobId);
  }

  async function maybeSyncRunningJobs() {
    if (!nocoDb?.getRunningJobSyncIdsDue) return;
    for (const jobId of nocoDb.getRunningJobSyncIdsDue()) {
      try { await nocoDb.syncJob(jobId); }
      catch (error) { console.error(`Incremental NocoDB sync failed for job ${jobId}:`, error.message); }
    }
  }

  function recoverStaleRunningShards() {
    for (const jobId of store.reclaimStaleRunningShards(config.runningShardStaleMs)) {
      console.warn(`Recovered stale running shard(s) for job ${jobId}.`);
    }
  }
}

function createJobId() { return crypto.randomUUID(); }

module.exports = { createWorker, createJobId };
