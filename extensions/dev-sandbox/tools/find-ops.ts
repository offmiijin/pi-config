/**
 * FindOperations — busca de arquivos via bwrap.
 */

import type { FindOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../types";
import { execInSandbox } from "../bwrap-executor";

export function createFindOps(config: SandboxConfig, cwd: string): FindOperations {
  return {
    async exists(filePath) {
      const { exitCode } = await execInSandbox(config, {
        command: ["test", "-e", filePath],
        cwd,
      });
      return exitCode === 0;
    },

    async glob(pattern, searchCwd, { limit }) {
      const { stdout } = await execInSandbox(config, {
        command: [
          "bash", "-c",
          [
            'find "$1"',
            "  -not -path '*/.git/*'",
            "  -not -path '*/node_modules/*'",
            '  -name "$2"',
            '  -print',
            `| head -n ${limit}`,
          ].join(" "),
          "_", searchCwd, pattern,
        ],
        cwd,
      });
      return stdout.toString().trim().split("\n").filter(Boolean);
    },
  };
}
