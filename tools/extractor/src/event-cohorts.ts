// One-off generator for data/aef/event-cohorts.json, the ledger that assigns
// every limited-time event item to its "cohort": the game version
// (vMAJOR.MINOR) that first shipped the item. The game reruns and retires
// events across patches, so "which event did this come from" is pinned by the
// AKEData mirror (https://data.akedata.wiki), which keeps one immutable copy
// of the game's TableCfg JSONs per hotfix. This script walks every retained
// AKEData version oldest-first and records the first version whose ItemTable
// carries each event item (#144).
//
// An item is an event item iff its ItemTable row lists the obtain-way id
// "item_obtain_activity_formula" in noObtainWayId - nothing else. The id
// prefix "item_activity_" is NOT part of the rule: it also matches coupon,
// sample and contract items that were never event-shop craftables and would
// manufacture a spurious cohort, while the formula field alone reproduces the
// accepted ledger (and catches fbottle_xiranenr_grass_2, an event item with
// no activity prefix at all).
//
// The output is deterministic - versions in walk order, ids sorted, no
// timestamps - so re-running against an unchanged manifest is a no-op. A new
// hotfix of a known game version changes nothing; a new minor appends one
// cohort. Each ItemTable is fetched exactly once per run, sequentially, which
// stays within the mirror's robots policy for one-off fetches (see
// vendor/akedata/README.md).

import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const MANIFEST_URL = "https://data.akedata.wiki/manifest.json";
const DATA_BASE_URL = "https://data.akedata.wiki";
const OUTPUT_PATH = resolve(REPO_ROOT, "data/aef/event-cohorts.json");

// The obtain-way id that marks an item as craftable in a limited-time event.
const FORMULA_OBTAIN_WAY = "item_obtain_activity_formula";

// Every gameVersion must be a plain major.minor.patch triple; the cohort key
// truncates to vMAJOR.MINOR and anything looser would make that ambiguous.
const GAME_VERSION_RE = /^\d+\.\d+\.\d+$/;

// The mirror 403s the default runtine User-Agent intermittently; a
// browser-like one is accepted.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface ManifestVersion {
  id: string;
  gameVersion: string;
  hotfixVersion: string;
  tableCfgPath: string;
  publishedAt: string;
}

// A manifest entry plus the parts the walk order and cohort key are derived
// from, parsed once up front so sorting never re-parses.
interface OrderedVersion {
  entry: ManifestVersion;
  major: number;
  minor: number;
  patch: number;
  publishedMs: number;
}

// The ledger written to data/aef/event-cohorts.json. `versions` records every
// AKEData version consulted, in walk order (oldest first), as the full
// "<gameVersion>@<hotfixVersion>" ids; `cohorts` maps each cohort key to the
// recipe-pack item ids (ItemTable key with the leading "item_" stripped) first
// seen in it, sorted.
interface EventCohortLedger {
  source: string;
  rule: string;
  versions: string[];
  cohorts: Record<string, string[]>;
}

async function main(): Promise<void> {
  // The CDN in front of the mirror hands out stale cached copies of
  // manifest.json (different edges were observed serving day-old version
  // lists alongside the fresh one despite cache-control: max-age=0), and a
  // stale list means missed versions. A unique query string forces the edge
  // to revalidate against origin; the per-version table paths are immutable,
  // so only the mutable manifest needs this.
  console.log(`fetching ${MANIFEST_URL}`);
  const manifest = await fetchJson(`${MANIFEST_URL}?t=${Date.now()}`);
  const ordered = orderVersions(manifest);
  console.log(
    `walk order (oldest first): ${ordered.map((v) => v.entry.id).join(", ")}`,
  );

  // Item id (item_ prefix stripped) -> cohort key of the first version that
  // carried it.
  const firstSeen = new Map<string, string>();
  // Cohort key -> the AKEData version id that first contributed it, for the
  // run summary only.
  const firstIn = new Map<string, string>();
  // Cohort key -> [major, minor], recorded when the cohort is first seen so
  // the ledger's key order can be ascending semantic version, not lexical
  // (v1.10 must sort after v1.2).
  const cohortOrder = new Map<string, [number, number]>();

  for (const v of ordered) {
    const url = `${DATA_BASE_URL}/${v.entry.tableCfgPath}/ItemTable.json`;
    // ItemTables are ~2-2.8 MB; fetch them one at a time to keep the walk
    // gentle on the mirror.
    const table = (await fetchJson(url)) as Record<string, unknown>;

    const cohort = `v${v.major}.${v.minor}`;
    let present = 0;
    let fresh = 0;
    for (const [key, row] of Object.entries(table)) {
      if (typeof row !== "object" || row === null) {
        throw new Error(`ItemTable ${v.entry.id}: row ${key} is not an object`);
      }
      const ways = (row as { noObtainWayId?: unknown }).noObtainWayId;
      if (ways === undefined) continue;
      if (!Array.isArray(ways)) {
        throw new Error(
          `ItemTable ${v.entry.id}: noObtainWayId of ${key} is not an array`,
        );
      }
      if (!ways.includes(FORMULA_OBTAIN_WAY)) continue;

      // ItemTable also keys non-factory rows (achievements, characters,
      // gacha gems, ...) without the item_ prefix; every formula row is a
      // proper item, so a formula marker on anything else is a shape change
      // worth failing on rather than silently stripping.
      if (!key.startsWith("item_")) {
        throw new Error(
          `ItemTable ${v.entry.id}: formula item ${key} lacks the item_ prefix`,
        );
      }
      const id = key.slice("item_".length);
      present++;
      if (firstSeen.has(id)) continue;
      firstSeen.set(id, cohort);
      fresh++;
      if (!cohortOrder.has(cohort)) {
        cohortOrder.set(cohort, [v.major, v.minor]);
        firstIn.set(cohort, v.entry.id);
      }
    }
    console.log(
      `  ${v.entry.id}: ${present} event items` +
        (fresh > 0 ? `, ${fresh} new (cohort ${cohort})` : ""),
    );
  }

  const cohorts: Record<string, string[]> = {};
  const sortedCohorts = [...cohortOrder.entries()].sort(
    (a, b) => a[1][0]! - b[1][0]! || a[1][1]! - b[1][1]!,
  );
  for (const [cohort] of sortedCohorts) cohorts[cohort] = [];
  for (const id of [...firstSeen.keys()].sort()) {
    cohorts[firstSeen.get(id)!]!.push(id);
  }

  const ledger: EventCohortLedger = {
    source: MANIFEST_URL,
    rule: `event items are ItemTable keys whose noObtainWayId contains "${FORMULA_OBTAIN_WAY}"`,
    versions: ordered.map((v) => v.entry.id),
    cohorts,
  };

  await Bun.write(OUTPUT_PATH, JSON.stringify(ledger, null, 2) + "\n");

  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(
    `  versions=${ordered.length} cohorts=${sortedCohorts.length} items=${firstSeen.size}`,
  );
  for (const [cohort] of sortedCohorts) {
    console.log(
      `  ${cohort}: ${cohorts[cohort]!.length} items (first in ${firstIn.get(cohort)})`,
    );
  }
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new Error(`fetch ${url} failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  // ItemTables carry bare int64 ids beyond Number.MAX_SAFE_INTEGER on fields
  // this walk never reads (e.g. decoDesc.id). JSON.parse rounds those to a
  // double, which is harmless here because only top-level keys and the
  // noObtainWayId string arrays are consulted - unlike the vendored snapshot,
  // which is stored byte for byte and never round-trips through JS.
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`parse ${url} failed: ${(err as Error).message}`);
  }
}

// Validate the manifest and return its versions in walk order: ascending
// semantic game version, ties broken by publishedAt. publishedAt is NOT
// monotone with version (the operator republished the pre-1.3 tables in one
// July batch), and its ISO offsets mix +00:00 and +08:00, so it is parsed to
// epoch millis rather than compared as a string.
function orderVersions(manifest: unknown): OrderedVersion[] {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("manifest is not an object");
  }
  const raw = (manifest as { versions?: unknown }).versions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("manifest has no versions[]");
  }

  const ordered: OrderedVersion[] = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("manifest version entry is not an object");
    }
    const e = entry as Record<string, unknown>;
    for (const field of [
      "id",
      "gameVersion",
      "hotfixVersion",
      "tableCfgPath",
      "publishedAt",
    ]) {
      if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
        throw new Error(
          `manifest version entry is missing its ${field} field: ${JSON.stringify(entry)}`,
        );
      }
    }
    const v: ManifestVersion = {
      id: e.id as string,
      gameVersion: e.gameVersion as string,
      hotfixVersion: e.hotfixVersion as string,
      tableCfgPath: e.tableCfgPath as string,
      publishedAt: e.publishedAt as string,
    };
    if (!GAME_VERSION_RE.test(v.gameVersion)) {
      throw new Error(
        `manifest version ${v.id}: gameVersion "${v.gameVersion}" is not major.minor.patch`,
      );
    }
    const publishedMs = Date.parse(v.publishedAt);
    if (Number.isNaN(publishedMs)) {
      throw new Error(
        `manifest version ${v.id}: publishedAt "${v.publishedAt}" is not a date`,
      );
    }
    const [major, minor, patch] = v.gameVersion.split(".").map((part) => {
      const n = Number(part);
      if (!Number.isSafeInteger(n)) {
        throw new Error(
          `manifest version ${v.id}: gameVersion component "${part}" overflows`,
        );
      }
      return n;
    }) as [number, number, number];
    return { entry: v, major, minor, patch, publishedMs };
  });

  ordered.sort(
    (a, b) =>
      a.major - b.major ||
      a.minor - b.minor ||
      a.patch - b.patch ||
      a.publishedMs - b.publishedMs,
  );
  return ordered;
}

if (import.meta.main) {
  await main();
}
