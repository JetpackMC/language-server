import { Using } from "./ast";

export class UsingError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = "UsingError";
  }
}

export function resolveUsingPath(stmt: Using, currentModulePath: string[]): string[] {
  const currentDir = currentModulePath.slice(0, -1);
  const upCount = stmt.relativeDots - 1;
  let base: string[];
  if (stmt.relativeDots === 0) {
    base = [];
  } else if (upCount > currentDir.length) {
    throw new UsingError("Using path cannot go above the root directory", stmt.line);
  } else {
    base = currentDir.slice(0, currentDir.length - upCount);
  }
  return [...base, ...stmt.path];
}

export function usingDisplayPath(stmt: Using): string {
  const prefix = ".".repeat(stmt.relativeDots);
  const suffix = stmt.recursive ? ".*" : "";
  return prefix + stmt.path.join(".") + suffix;
}
