/** A different run currently owns this Agent's owner-configured body slot. */
export class ComputeRunBusyError extends Error {
  constructor() {
    super("compute concurrency slot is busy");
    this.name = "ComputeRunBusyError";
  }
}
