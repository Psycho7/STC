# vendor/endfield-calc

Partial vendored snapshot of the `endfield-calc/factoriolab` fork (EndfieldLab),
taken from its `src/data/aef/` directory. This is a snapshot of selected files,
not a git submodule and not the full fork.

## Provenance

The exact origin is recorded in `SOURCE.json`:

- Repo: https://github.com/endfield-calc/factoriolab
- Upstream lineage: https://github.com/factoriolab/factoriolab (FactorioLab, Doug Broad)
- Commit: `4fc462948fe9f652db20258953dd8dc09b3dfc97`
- Game version: `v1.2.4`

## Contents

- `data.json` - upstream item/recipe/machine/category data plus icon-atlas
  metadata. Consumed by the extractor (recipe data) and by the app icon layer
  (icon positions).
- `i18n/{en,ja,ru,zh}.json` - upstream localized display names. Consumed by the
  extractor to build the i18n sidecar.
- `icons.webp` - upstream icon sprite sheet. Consumed by the app icon layer.
- `LICENSE` - the fork's MIT license (covers the calculator-code lineage only).
- `SOURCE.json` - machine-readable provenance the extractor reads to stamp the
  recipe-pack `source` block.

## License and game content

The MIT `LICENSE` covers the FactorioLab/EndfieldLab code lineage. It does NOT
cover the bundled Arknights: Endfield game data (the contents of `data.json`) or
the icon art (`icons.webp`), which belong to their respective rights holders. See
the top-level `NOTICE` for details.

## Refreshing the snapshot

1. Replace the files above with the newer fork's `src/data/aef/` slice.
2. Update `commit`, `gameVersion`, and `snapshotDate` in `SOURCE.json`.
3. Re-run the extractor: `bun run tools/extractor/src/extract.ts` (or `npm run extract`).
