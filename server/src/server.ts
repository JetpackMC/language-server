import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeParams,
  InitializeResult,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  Diagnostic,
  DiagnosticSeverity,
  Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { JetpackAnalyzer, RawDiagnostic } from "./analysis";
import { Workspace } from "./workspace";
import { completion, documentSymbols } from "./features";
import {
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  SymbolIndex,
} from "./symbolIndex";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new Workspace();
const analyzer = new JetpackAnalyzer();

let diagnosticsEnabled = true;
let hasConfigurationCapability = false;
let analyzeTimer: NodeJS.Timeout | null = null;
let symbolIndex: SymbolIndex | null = null;
const publishedUris = new Set<string>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
  workspace.setWorkspaceFolder(resolveWorkspaceFolder(params));
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["."] },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      documentSymbolProvider: true,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
        },
        full: true,
      },
    },
  };
});

connection.onInitialized(async () => {
  await refreshConfiguration();
  try {
    await connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [{ globPattern: "**/*.jet" }],
    });
  } catch {
  }
  workspace.scanDiskFiles();
  scheduleAnalysis();
});

documents.onDidOpen((event) => {
  workspace.openDocument(event.document.uri, event.document.getText());
  scheduleAnalysis();
});

documents.onDidChangeContent((event) => {
  workspace.openDocument(event.document.uri, event.document.getText());
  scheduleAnalysis();
});

documents.onDidClose((event) => {
  workspace.closeDocument(event.document.uri);
  workspace.updateDiskFile(event.document.uri);
  scheduleAnalysis();
});

connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    if (documents.get(change.uri)) continue;
    if (change.type === FileChangeType.Deleted) workspace.removeDiskFile(change.uri);
    else workspace.updateDiskFile(change.uri);
  }
  scheduleAnalysis();
});

connection.onDidChangeConfiguration(async () => {
  await refreshConfiguration();
  scheduleAnalysis();
});

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) return [];
  return completion(document, document.offsetAt(params.position), ensureSymbolIndex());
});

connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) return [];
  return documentSymbols(document);
});

connection.onHover((params) =>
  ensureSymbolIndex().hover(params.textDocument.uri, params.position),
);

connection.onSignatureHelp((params) =>
  ensureSymbolIndex().signatureHelp(params.textDocument.uri, params.position),
);

connection.onDefinition((params) =>
  ensureSymbolIndex().definition(params.textDocument.uri, params.position),
);

connection.onReferences((params) =>
  ensureSymbolIndex().references(
    params.textDocument.uri,
    params.position,
    params.context.includeDeclaration,
  ),
);

connection.onPrepareRename((params) =>
  ensureSymbolIndex().prepareRename(params.textDocument.uri, params.position),
);

connection.onRenameRequest((params) => ensureSymbolIndex().rename(params));

connection.languages.semanticTokens.on((params) =>
  ensureSymbolIndex().semanticTokens(params.textDocument.uri),
);

function resolveWorkspaceFolder(params: InitializeParams): string | null {
  const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? null;
  return folder !== null ? URI.parse(folder).fsPath : null;
}

async function refreshConfiguration(): Promise<void> {
  if (!hasConfigurationCapability) return;
  const config = await connection.workspace.getConfiguration({ section: "jetpack" });
  diagnosticsEnabled = config?.diagnostics?.enable !== false;
  workspace.setConfiguredScriptsRoot(typeof config?.scriptsRoot === "string" ? config.scriptsRoot : "");
}

function scheduleAnalysis(): void {
  if (analyzeTimer !== null) clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runAnalysis, 200);
}

function runAnalysis(): void {
  analyzeTimer = null;
  const docs = workspace.documents();
  rebuildSymbolIndex(docs);

  if (!diagnosticsEnabled) {
    clearStaleDiagnostics(new Set());
    return;
  }

  const results = analyzer.analyze(docs, (uri) => workspace.pathSegmentsOf(uri));
  const textByUri = new Map(docs.map((doc) => [doc.uri, doc.text]));
  const activeUris = new Set<string>();

  for (const [uri, raw] of results) {
    const text = textByUri.get(uri) ?? "";
    const diagnostics = raw.map((entry) => toDiagnostic(entry, text));
    connection.sendDiagnostics({ uri, diagnostics });
    publishedUris.add(uri);
    activeUris.add(uri);
  }

  clearStaleDiagnostics(activeUris);
}

function ensureSymbolIndex(): SymbolIndex {
  if (symbolIndex === null) rebuildSymbolIndex(workspace.documents());
  return symbolIndex!;
}

function rebuildSymbolIndex(docs: { uri: string; text: string }[]): void {
  symbolIndex = SymbolIndex.fromDocuments(
    docs.map((doc) => ({
      ...doc,
      pathSegments: workspace.pathSegmentsOf(doc.uri),
    })),
  );
}

function clearStaleDiagnostics(activeUris: Set<string>): void {
  for (const uri of [...publishedUris]) {
    if (!activeUris.has(uri)) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
      publishedUris.delete(uri);
    }
  }
}

function toDiagnostic(entry: RawDiagnostic, text: string): Diagnostic {
  const range = entry.kind === "offset" ? offsetRange(text, entry.start, entry.end) : lineRange(text, entry.line);
  return {
    severity: DiagnosticSeverity.Error,
    range,
    message: entry.message,
    source: "jetpack",
  };
}

function offsetRange(text: string, start: number, end: number): Range {
  return { start: positionAt(text, start), end: positionAt(text, end) };
}

function lineRange(text: string, line: number): Range {
  const lineIndex = Math.max(0, line - 1);
  const lines = text.split("\n");
  const content = lines[lineIndex] ?? "";
  const firstNonWhitespace = content.length - content.trimStart().length;
  return {
    start: { line: lineIndex, character: content.trim().length > 0 ? firstNonWhitespace : 0 },
    end: { line: lineIndex, character: content.length },
  };
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

documents.listen(connection);
connection.listen();
