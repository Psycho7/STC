# vendor/akedata

Pinned snapshot of 14 AKEData `TableCfg` tables, stored byte for byte as the
data host serves them. AKEData republishes the game's own TableCfg files per
hotfix; this directory pins one hotfix so the extractor can read the tables
offline and the pin moves visibly in version control. This is a pinned copy,
not a git submodule and not a projection: no file here is generated,
reformatted, or filtered.

## Provenance

The exact origin is recorded in `SOURCE.json`, which is the single source of
truth for the snapshot's `version`, `gameVersion`, `hotfixVersion` and
`snapshotDate`; it is never paraphrased here. The tables sit at
`vendor/akedata/<gameVersion>/<hotfixVersion>/TableCfg/`, and the manifest's
`tableCfgPath` is `public/` followed by that same relative path, so each file
was fetched from `https://data.akedata.wiki/<tableCfgPath>/<Table>.json`.

- Site: https://www.akedata.wiki
- Data host: https://data.akedata.wiki
- Code repo: https://github.com/NagiYume/AKEDatabase

## Contents

`<gameVersion>/<hotfixVersion>/TableCfg/` holds the 14 tables:

- `ItemTable` - every game item: ids, localized name/description ids, icon
  ids, stack counts. The item-id half of the join to the recipe pack.
- `FactoryItemTable` - the factory subset of items with logistics fields:
  buffer stack limits, transfer and lossless domains, item state.
- `FactoryMachineCraftTable` - the recipes: per craft, machine, ingredients,
  outcomes, duration, formula group, and the `gasEnv` environment
  requirement the current vendor does not carry.
- `FactoryMachineCraftGroupTable` - alternate crafts grouped by formula
  group, with their buffer bindings and round time.
- `FactoryBuildingTable` - building definitions: power draw, input and
  output ports, place domains. The machine-id half of the join.
- `FactoryEnvDisplayTable` - display rows for the environments (icon atlas
  and effect per `GenEnv` id).
- `FactoryVaporizerTable` - the vaporizer: consume bindings and range
  extension.
- `FactoryMinerTable` - ore miners: mineable position, round time, drone
  mode.
- `FactoryGasMinerTable` - the gas miner: mineable position and round time.
- `FactoryFluidPumpInTable` - fluid pumps: pump positions and which liquids
  each enables.
- `FactoryFluidConsumeTable` - the fluid consumer: which liquid it consumes
  and its round time.
- `FactoryFuelItemTable` - fuel items: fuel energy and power provided.
- `FactoryPowerStationTable` - the power station: power provided per round.
- `WikiDefaultCraftTable` - the craft the site marks as default for each of
  the 9 items with more than one craft.

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

The AKEDatabase code repo declares AGPL-3.0 in its README while its LICENSE
file carries GPLv3 text; see the top-level `NOTICE` for both statements.
Either way the license covers the site code only. The vendored tables are
the game's own TableCfg data and belong to their respective rights holders
(Hypergryph / Gryphline / Yostar), covered by the game-content section of
the `NOTICE`. Nothing from the repository's code is vendored.

## Refreshing the snapshot

1. Fetch `https://data.akedata.wiki/manifest.json` and pick the entry to
   pin; `versions[]` carries `id`, `gameVersion`, `hotfixVersion`,
   `tableCfgPath` and `publishedAt`.
2. Fetch the 14 tables above from
   `https://data.akedata.wiki/<tableCfgPath>/<Table>.json`, byte for byte.
3. Replace the versioned directory
   `vendor/akedata/<gameVersion>/<hotfixVersion>/` with the new fetch; the
   old versioned directory is removed in the same change so the diff shows
   the two versions side by side.
4. Update `version`, `gameVersion`, `hotfixVersion`, `tableCfgPath`,
   `publishedAt` and `snapshotDate` in `SOURCE.json`.

The operator's tooling can delete remote versions and re-point `latest`, so
the vendored copy is the pin, not the URL. A one-off fetch is within the
site's robots allow; before any recurring pull, contact the operator first
(Bilibili `space.bilibili.com/694452100`, QQ group 1091817282, per #104).
