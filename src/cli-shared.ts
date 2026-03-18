import { readBoardRC, type BoardRC } from "./boardrc.js";

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function die(message: string): never {
  throw new CliError(message);
}

export function requireRC(): BoardRC {
  const rc = readBoardRC();
  if (!rc) die("No .boardrc found. Run `board init` first.");
  return rc;
}
