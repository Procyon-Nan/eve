import type { Command } from "#compiled/commander/index.js";

/** Offline maintenance deliberately does not require or load an authored app. */
export function registerRepairReplayCommand(program: Command): void {
  const repair = program
    .command("repair-replay")
    .description("Inspect or clean up failed .2-to-.3 replay sessions offline.");
  for (const mode of ["inspect", "apply"] as const) {
    const command = repair
      .command(mode)
      .requiredOption("--data-dir <path>", "Existing local Workflow data directory")
      .requiredOption("--output <path>", "JSON report outside the Workflow data directory");
    if (mode === "apply")
      command
        .requiredOption("--manifest <path>", "Manifest produced by inspect")
        .option(
          "--writers-stopped",
          "Confirm all application writers are stopped and current data is backed up",
        );
    command.action(
      async (options: {
        dataDir: string;
        output: string;
        manifest?: string;
        writersStopped?: boolean;
      }) => {
        const { runRepairReplay } = await import("./repair-replay.js");
        if (!(await runRepairReplay({ mode, ...options }))) process.exitCode = 1;
      },
    );
  }
}
