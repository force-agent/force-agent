export * as SelfUpdateApplier from "./self-update"

import { SelfUpdate } from "@opencode-ai/core/self-update"
import type { LayerNode } from "@opencode-ai/util/effect/layer-node"

/**
 * force-agent overlay: the host side of self-update, reachable from the CLI.
 *
 * The CLI does not import `@opencode-ai/core` (see `packages/cli/test/import-boundaries.test.ts`),
 * so the applier contract and the `createRoutes` replacement that installs one are re-exported
 * here, next to `ServerProcess.start(options, lifecycle, transform, overrides)`.
 */
export type Applier = SelfUpdate.Applier
export type Detection = SelfUpdate.Detection

/** The replacement to pass in `overrides` so `/api/update/apply` can install and restart. */
export function override(applier: Applier): LayerNode.Replacement {
  return [SelfUpdate.node, SelfUpdate.configured({ applier })]
}
