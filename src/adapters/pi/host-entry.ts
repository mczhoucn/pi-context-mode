/** Pi-only loader boundary. Static root imports work in both bundled and
 * unbundled Pi 0.85.1; dynamic imports cannot resolve the host's virtual SDK.
 * Keep ordinary Node tests/shared adapters on the injectable extension module.
 */
import * as sdk from "@earendil-works/pi-coding-agent";
import piExtension from "./extension.js";

export default function contextModePi(pi: any): void {
  piExtension(pi, sdk);
}
