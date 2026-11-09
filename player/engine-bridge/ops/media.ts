import type { MediaLoadReport } from "../../../src/playback.js";
import { reportPlayerRuntimeMediaLoad } from "../../runtime/runtime-adapter.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps } from "../worker-host.js";
import { publishing, sessionOp } from "./session.js";

/** The ops of family L5d (the L5 series): a medium's load report. */
export function mediaOps(_context: PlayerOpsContext): BridgeOps {
  return {
    // A medium loaded, or failed to. The engine checks the report against its media ID, which says what it is about,
    // so like L5c's input ops it reads no basis.
    reportMediaLoad: sessionOp(
      (args) =>
        isRecord(args) &&
        exactly(args, ["mediaId", "report"]) &&
        typeof args.mediaId === "number" &&
        Number.isSafeInteger(args.mediaId) &&
        args.mediaId >= 0 &&
        isRecord(args.report),
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { mediaId, report } = args as {
          readonly mediaId: number;
          readonly report: MediaLoadReport;
        };
        held.endCatchUp();
        const result = reportPlayerRuntimeMediaLoad(held.sessionForOperation(), mediaId, report);
        return publishing(held, result.session, result.outcome);
      },
      false,
    ),
  };
}
