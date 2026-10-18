// Stream B: SubQ clients. Snap (Decisions API) = router + note auditor; subq-preview (chat) = args, distiller, notes.
import type { ArgFiller, Distiller, NoteAuditor, NoteWriter, ProviderDiag, Router } from "../runtime/types.js";

export function createSubq(_env: NodeJS.ProcessEnv): {
  router: Router | null; args: ArgFiller | null; distiller: Distiller | null; noteWriter: NoteWriter | null;
  auditor: NoteAuditor | null; diags: ProviderDiag[];
} {
  return { router: null, args: null, distiller: null, noteWriter: null, auditor: null, diags: [] };
}
