// @ts-check

/** @typedef {import("./workflow.js").Workflow} Workflow */

/** @type {Workflow} */
export default async function implement(runtime, args) {
  const task = args.join(" ").trim();
  if (!task) {
    throw new Error("Usage: /run-workflow implement <task>");
  }

  const worker = runtime.createHandle({ label: "implement" }).skill("tdd");
  const reviewer = runtime.createHandle({ label: "review" }).skill("code-review");

  try {
    const fixedPoint = (await worker.execute(
      "Run `git rev-parse HEAD` in the project and return only the resulting full commit SHA, with no other text.",
    )).trim();
    if (!/^[0-9a-f]{40}$/i.test(fixedPoint)) {
      throw new Error(`Could not establish the starting commit: ${fixedPoint}`);
    }

    const implementation = await worker.execute(`Implement this task completely:\n\n${task}\n\n` +
      `The fixed point from before implementation is ${fixedPoint}. Inspect the repository context and relevant specs first. ` +
      "Use test-driven development only at test seams already agreed in the task; do not invent a seam or block waiting for confirmation. " +
      "Run typechecking and focused tests regularly while working, then run the full test suite once at the end. " +
      "Preserve unrelated work and commit only your changes to the current branch. Return a concise implementation summary, tests run, and commit SHA(s).",
    );

    const review = await reviewer.execute(`Review the implementation of the task below using ${fixedPoint} as the fixed point.\n\n` +
      `Task/spec:\n${task}\n\nImplementation report:\n${implementation}\n\n` +
      "The task text above is the supplied spec source. Review the committed diff through HEAD along both Standards and Spec axes as directed by the code-review skill. Return actionable findings, or explicitly state that there are none.",
    );

    return await worker.execute(`Apply the valid findings from this completed code review:\n\n${review}\n\n` +
      `Re-check the original task:\n${task}\n\n` +
      "Inspect each finding against the code before changing anything. Fix valid findings, preserve unrelated work, and do not expand scope. " +
      "Run relevant focused tests and typechecking, then run the full test suite once after all fixes. Commit any review fixes to the current branch; if no code changes are needed, do not create an empty commit. " +
      "Return a non-empty final summary containing the completed behavior, review outcome, tests/typechecks run, and final commit SHA(s).",
    );
  } finally {
    await Promise.allSettled([worker.close(), reviewer.close()]);
  }
}
