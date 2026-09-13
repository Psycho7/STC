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

1. Fetch `https://data.akedata.wiki/manifest.json` and pick the entry to
   pin; `versions[]` carries `id`, `gameVersion`, `hotfixVersion`,
   `tableCfgPath` and `publishedAt`.
2. Fetch the 14 tables above from
   `https://data.akedata.wiki/<tableCfgPath>/<Table>.json`, byte for byte.
3. Add the new versioned directory and remove the old one in the same
   change, so the diff shows both versions.
4. Update `version`, `gameVersion`, `hotfixVersion`, `tableCfgPath`,
   `publishedAt` and `snapshotDate` in `SOURCE.json`.

The operator's tooling can delete remote versions and re-point `latest`, so
the vendored copy is the pin, not the URL. A one-off fetch is within the
site's robots allow; before any recurring pull, contact the operator first
(Bilibili `space.bilibili.com/694452100`, QQ group 1091817282, per #104).
