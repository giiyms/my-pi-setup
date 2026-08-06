import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Restore `/exit` as an alias of built-in `/quit`. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Exit pi cleanly (alias of /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
