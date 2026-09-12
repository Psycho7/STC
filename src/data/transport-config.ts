import type { Item, RecipePack, TransportKindId } from "@aef/schema";
import raw from "@aef/data/transport-config.json";

export class UnknownCarrierError extends Error {
  constructor(
    public itemId: Item["id"] | null,
    public kind: TransportKindId,
  ) {
    super(
      itemId === null
        ? `unknown carrier kind '${kind}'`
        : `unknown carrier kind '${kind}' for item '${itemId}'`,
    );
    this.name = "UnknownCarrierError";
  }
}

export type TransportConfig = {
  schemaVersion: string;
  source: string;
  lanesPerBlueprintGroup: number;
  interGroupGapTiles: number;
  carriers: Record<
    TransportKindId,
    { transportId: string; itemsPerSecondPerLane: number }
  >;
};

const EXPECTED_SCHEMA = "0.2";

export const defaultTransportConfig: TransportConfig = raw as TransportConfig;

/**
 * Validate that every carrier kind the pack names has a config entry, and
 * return the config. This is the only carrier-kind check left: the solver
 * stopped taking a transport config, so a kind missing from the config is
 * caught here alone. The app runs this at startup; the CLI tools do not, so
 * they would render an unknown kind without complaint.
 */
export function loadTransportConfig(
  config: TransportConfig,
  pack: RecipePack,
): TransportConfig {
  if (config.schemaVersion !== EXPECTED_SCHEMA) {
    console.warn(
      `transport-config schemaVersion drift: config=${config.schemaVersion}, expected=${EXPECTED_SCHEMA}`,
    );
  }
  const carrierKeys = new Set(Object.keys(config.carriers));
  // Validate both places a carrier kind can show up. `pack.transports[].kind`
  // catches a missing carrier in the catalogue, and `pack.items[].transportKind`
  // catches one missing on the demand side, which is the field the canvas reads
  // to pick an edge's transport styling. The extractor keeps these two sets in
  // sync today, but checking both means a future extractor regression won't
  // slip past this load-time guard.
  for (const t of pack.transports) {
    if (!carrierKeys.has(t.kind)) {
      throw new UnknownCarrierError(null, t.kind);
    }
  }
  for (const item of pack.items) {
    if (!carrierKeys.has(item.transportKind)) {
      throw new UnknownCarrierError(item.id, item.transportKind);
    }
  }
  return config;
}
