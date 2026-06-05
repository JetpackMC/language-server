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
    return this.detectScriptRoot(fsPath) ?? this.workspaceFolderFsPath;
  }

  private detectScriptRoot(fsPath: string): string | null {
    const scriptDirs = this.directoriesContainingScripts();
    let dir = path.dirname(fsPath);
    if (!scriptDirs.has(normalizePath(dir))) return null;

    const workspaceRoot = this.workspaceFolderFsPath !== null ? path.resolve(this.workspaceFolderFsPath) : null;
    let root = dir;
    while (true) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      if (workspaceRoot !== null && !isSameOrNestedPath(parent, workspaceRoot)) break;
      if (!scriptDirs.has(normalizePath(parent))) break;
      root = parent;
      dir = parent;
    }
    return root;
  }

  private directoriesContainingScripts(): Set<string> {
    const dirs = new Set<string>();
    for (const uri of this.documentsByUri().keys()) {
      dirs.add(normalizePath(path.dirname(URI.parse(uri).fsPath)));
    }
    return dirs;
  }

  private documentsByUri(): Map<string, string> {
    const merged = new Map<string, string>(this.diskContents);
    for (const [uri, text] of this.openContents) merged.set(uri, text);
    return merged;
  }
}

function isSameOrNestedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePath(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

