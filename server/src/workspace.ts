import * as fs from "fs";
import * as path from "path";
import { URI } from "vscode-uri";

export class Workspace {
  private readonly diskContents = new Map<string, string>();
  private readonly openContents = new Map<string, string>();
  private workspaceFolderFsPath: string | null = null;
  private configuredScriptsRoot = "";

  setWorkspaceFolder(fsPath: string | null): void {
    this.workspaceFolderFsPath = fsPath;
  }

  setConfiguredScriptsRoot(value: string): void {
    this.configuredScriptsRoot = value.trim();
  }

  openDocument(uri: string, text: string): void {
    this.openContents.set(uri, text);
  }

  closeDocument(uri: string): void {
    this.openContents.delete(uri);
  }

  scanDiskFiles(): void {
    this.diskContents.clear();
    const root = this.workspaceFolderFsPath;
    if (root === null) return;
    for (const filePath of walkJetFiles(root)) {
      const uri = URI.file(filePath).toString();
      try {
        this.diskContents.set(uri, fs.readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
    }
  }

  updateDiskFile(uri: string): void {
    const fsPath = URI.parse(uri).fsPath;
    try {
      this.diskContents.set(uri, fs.readFileSync(fsPath, "utf8"));
    } catch {
      this.diskContents.delete(uri);
    }
  }

  removeDiskFile(uri: string): void {
    this.diskContents.delete(uri);
  }

  documents(): { uri: string; text: string }[] {
    return [...this.documentsByUri()].map(([uri, text]) => ({ uri, text }));
  }

  pathSegmentsOf(uri: string): string[] {
    const fsPath = URI.parse(uri).fsPath;
    const root = this.scriptsRootFsPath(fsPath);
    const relative = root !== null ? path.relative(root, fsPath) : path.basename(fsPath);
    return relative
      .split(path.sep)
      .join("/")
      .replace(/\.jet$/, "")
      .split("/")
      .filter((segment) => segment.length > 0);
  }

  private scriptsRootFsPath(fsPath: string): string | null {
    if (this.configuredScriptsRoot.length > 0) {
      if (path.isAbsolute(this.configuredScriptsRoot)) return this.configuredScriptsRoot;
      if (this.workspaceFolderFsPath !== null) {
        return path.resolve(this.workspaceFolderFsPath, this.configuredScriptsRoot);
      }
      return this.configuredScriptsRoot;
    }
    return this.nearestManifestDir(fsPath) ?? this.workspaceFolderFsPath;
  }

  private nearestManifestDir(fsPath: string): string | null {
    const workspaceRoot = this.workspaceFolderFsPath;
    if (workspaceRoot === null) return null;

    let current = path.dirname(fsPath);
    const root = path.resolve(workspaceRoot);
    while (isSameOrNestedPath(current, root)) {
      if (this.directoryHasManifest(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  private directoryHasManifest(dir: string): boolean {
    const targetDir = normalizePath(dir);
    for (const [uri, text] of this.documentsByUri()) {
      const fileDir = normalizePath(path.dirname(URI.parse(uri).fsPath));
      if (fileDir === targetDir && containsManifestDeclaration(text)) return true;
    }
    return false;
  }

  private documentsByUri(): Map<string, string> {
    const merged = new Map<string, string>(this.diskContents);
    for (const [uri, text] of this.openContents) merged.set(uri, text);
    return merged;
  }
}

function walkJetFiles(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jet")) {
        results.push(full);
      }
    }
  }
  return results;
}

function isSameOrNestedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePath(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function containsManifestDeclaration(source: string): boolean {
  let pos = 0;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '"' || ch === "'") {
      pos = skipString(source, pos, ch);
    } else if (ch === "/" && source[pos + 1] === "/") {
      pos = skipLineComment(source, pos + 2);
    } else if (ch === "/" && source[pos + 1] === "*") {
      pos = skipBlockComment(source, pos + 2);
    } else if (isIdentifierStart(ch)) {
      const start = pos;
      pos++;
      while (pos < source.length && isIdentifierPart(source[pos])) pos++;
      if (source.slice(start, pos) === "manifest" && nextNonWhitespace(source, pos) === "{") return true;
    } else {
      pos++;
    }
  }
  return false;
}

function skipString(source: string, start: number, quote: string): number {
  let pos = start + 1;
  while (pos < source.length) {
    if (source[pos] === "\\") {
      pos += 2;
    } else if (source[pos] === quote) {
      return pos + 1;
    } else {
      pos++;
    }
  }
  return pos;
}

function skipLineComment(source: string, start: number): number {
  let pos = start;
  while (pos < source.length && source[pos] !== "\n") pos++;
  return pos;
}

function skipBlockComment(source: string, start: number): number {
  let pos = start;
  while (pos < source.length) {
    if (source[pos] === "*" && source[pos + 1] === "/") return pos + 2;
    pos++;
  }
  return pos;
}

function nextNonWhitespace(source: string, start: number): string | null {
  let pos = start;
  while (pos < source.length && /\s/.test(source[pos])) pos++;
  return pos < source.length ? source[pos] : null;
}

function isIdentifierStart(ch: string): boolean {
  return ch === "_" || /\p{L}/u.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}
