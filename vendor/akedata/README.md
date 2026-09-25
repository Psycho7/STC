# vendor/akedata

Pinned snapshot of 14 AKEData `TableCfg` tables, stored byte for byte as the
data host serves them. AKEData republishes the game's own TableCfg files per
hotfix; this directory pins one hotfix so the extractor can read the tables
offline and the pin moves visibly in version control. This is a pinned copy,
not a git submodule.

## Provenance

The exact origin is recorded in `SOURCE.json`, which is the single source of
truth for the snapshot's `version`, `gameVersion`, `hotfixVersion`,
`tableCfgPath` and `snapshotDate`; it is never paraphrased here. The tables
sit at `<gameVersion>/<hotfixVersion>/TableCfg/` under this directory, which
is `tableCfgPath` with its `public/` prefix removed; each file was fetched from
`https://data.akedata.wiki/<tableCfgPath>/<Table>.json`.

- Site: https://www.akedata.wiki
- Code repo: https://github.com/NagiYume/AKEDatabase

## Contents

The versioned directory holds the 14 tables:

- `ItemTable` - every game item; the item-id half of the join to the recipe
  pack.
- `FactoryItemTable` - the factory subset of items with their logistics
  fields.
- `FactoryMachineCraftTable` - the recipes, including the `gasEnv`
  environment requirement the current vendor does not carry.
- `FactoryMachineCraftGroupTable` - alternate crafts grouped by formula group,
  with the round time.
- `FactoryBuildingTable` - building definitions; the machine-id half of the
  join.
- `FactoryEnvDisplayTable` - the environments by `GenEnv` id.
- `FactoryVaporizerTable` - which gas produces each environment.
- `FactoryMinerTable`, `FactoryGasMinerTable`, `FactoryFluidPumpInTable`,
  `FactoryFluidConsumeTable` - the extraction machines and their round times.
- `FactoryFuelItemTable`, `FactoryPowerStationTable` - fuel energy and power
  generation.
- `WikiDefaultCraftTable` - the craft the site marks as default for each item
  with more than one source.

The files are two-space JSON with LF endings and no trailing newline at EOF
(git shows `\ No newline at end of file`); that is the served byte stream and
stays as is. `ItemTable`, `FactoryMachineCraftTable` and
`FactoryBuildingTable` carry bare int64 ids beyond the JS safe-integer range;
readers must quote them before `JSON.parse` (the regex is in #104), which is
why the snapshot never round-trips through JS.

Not vendored, per #104: the `I18nTextTable_*` locale tables (about 12 MB per
locale; nothing in this phase reads a name) and images (the app takes icon
atlas positions and per-icon colours from the endfield-calc vendor, so icons
stay there).

## License and game content

The AKEDatabase license covers the site code only, and none of that code is
vendored here. The tables are Arknights: Endfield game data and belong to
their respective rights holders. See the top-level `NOTICE` for the license
statements and scope.

## Refreshing the snapshot

1. Fetch `https://data.akedata.wiki/manifest.json?cb=<nonce>` and pick the
   entry to pin; `versions[]` carries `id`, `gameVersion`, `hotfixVersion`,
   `tableCfgPath` and `publishedAt`. The nonce is required: the manifest is
   served through a cache that returns a stale `latest` without it.
2. Fetch the 14 tables above from
   `https://data.akedata.wiki/<tableCfgPath>/<Table>.json`, byte for byte.
   Capture each response's `ETag`, which is the MD5 of the body.
3. Add the new versioned directory and remove the old one in the same
   change, so the diff shows both versions.
4. Update `version`, `gameVersion`, `hotfixVersion`, `tableCfgPath`,
   `publishedAt` and `snapshotDate` in `SOURCE.json`.
5. Append a refresh log entry below with the row count and ETag of every
   table, so `jq length` and `md5sum` have a written expectation to check
   against.

The operator's tooling can delete remote versions and re-point `latest`, so
the vendored copy is the pin, not the URL. A one-off fetch is within the
site's robots allow; before any recurring pull, contact the operator first
(Bilibili `space.bilibili.com/694452100`, QQ group 1091817282, per #104).

## Refresh log

### 1.5.3@10024360-6, fetched 2026-09-19

Published `2026-09-08T05:34:51.667413+00:00`. Replaces `1.5.3@9913107-5`.
All 14 tables are byte-identical to the previous pin: every ETag and row
count below matches the `9913107-5` snapshot, and the host also serves the
same `ItemTable` ETag for the older `9885010-4`, so these tables did not
change across the hotfix. The paths are distinct on the host (an invented
version returns 404) and `last-modified` is the new hotfix's publish time.

| Table | Rows | ETag |
| --- | --- | --- |
| `FactoryMachineCraftTable` | 317 | `92aa3aa7abdc5e1e535da5b7f9f95625` |
| `FactoryMachineCraftGroupTable` | 28 | `0d75e5758d5cb6a605248b87319f614b` |
| `FactoryBuildingTable` | 112 | `cce322a674cad222b6f5109932283a1b` |
| `FactoryItemTable` | 564 | `5e30bf43f9db10f6db074e4c29b81770` |
| `ItemTable` | 2829 | `0b08404d53aecaa7c22cdff89886fe02` |
| `FactoryEnvDisplayTable` | 4 | `bf2a0c73cf048bcf0fbabf4d29b7c7f8` |
| `FactoryVaporizerTable` | 1 | `31c600cf7bac6b38344e54a609937924` |
| `FactoryMinerTable` | 4 | `3ed7d27489a4e63931eaa8b068eeec54` |
| `FactoryGasMinerTable` | 1 | `71fd99c2288810b2828d7cfa003829b4` |
| `FactoryFluidPumpInTable` | 2 | `0f17f25133543e584b0ffda0f4a28807` |
| `FactoryFluidConsumeTable` | 1 | `bd14ef61898e0aea0bcab16bc377e2af` |
| `FactoryFuelItemTable` | 6 | `2986841104fe6f3975d6b8c52ca71030` |
| `FactoryPowerStationTable` | 1 | `d4dd6142067d41011d911f490ba6cec8` |
| `WikiDefaultCraftTable` | 9 | `c695b11455bb27513fc14d651edc9f49` |
