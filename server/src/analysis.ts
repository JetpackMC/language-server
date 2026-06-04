import { Lexer, LexerError } from "./language/lexer";
import { Parser, ParseError } from "./language/parser";
import { ScriptModule, collectExportDefinitions } from "./language/module";
import { ModuleGraph, ModuleGraphDeps } from "./language/moduleGraph";
import { DefaultBuiltinTypeProvider } from "./language/builtins";
import { STANDARD_MODULE_TYPES } from "./language/stdlib";
import { isKnownEvent } from "./language/events";
import { Statement } from "./language/ast";

export type RawDiagnostic =
  | { kind: "offset"; message: string; start: number; end: number }
  | { kind: "line"; message: string; line: number; prevLine?: number };

export interface SourceDocument {
  uri: string;
  text: string;
}

export class JetpackAnalyzer {
  private readonly provider = new DefaultBuiltinTypeProvider();
  private readonly deps: ModuleGraphDeps = {
    namedModuleTypes: STANDARD_MODULE_TYPES,
    builtinGlobalNames: this.provider.globalNames(),
    typeProvider: this.provider,
    isKnownEvent,
  };

  analyze(
    documents: SourceDocument[],
    pathSegmentsOf: (uri: string) => string[],
  ): Map<string, RawDiagnostic[]> {
    const diagnostics = new Map<string, RawDiagnostic[]>();
    const modules: ScriptModule[] = [];

    for (const doc of documents) {
      diagnostics.set(doc.uri, []);
      const parsed = this.parse(doc, diagnostics.get(doc.uri)!);
      if (parsed === null) continue;
      modules.push({
        uri: doc.uri,
        pathSegments: pathSegmentsOf(doc.uri),
        stmts: parsed.stmts,
        sourceLines: doc.text.split("\n"),
        exportDefinitions: collectExportDefinitions(parsed.stmts),
        resolvedImports: [],
        validationState: null,
      });
    }

    const graphErrors = new ModuleGraph(modules, this.deps).analyze();
    for (const err of graphErrors) {
      const bucket = diagnostics.get(err.uri);
      if (bucket) bucket.push({ kind: "line", message: err.message, line: err.line, prevLine: err.prevLine });
    }

    return diagnostics;
  }

  private parse(doc: SourceDocument, out: RawDiagnostic[]): { stmts: Statement[] } | null {
    try {
      const tokens = new Lexer(doc.text).tokenize();
      const stmts = new Parser(tokens).parseFile();
      return { stmts };
    } catch (e) {
      if (e instanceof LexerError || e instanceof ParseError) {
        const start = e instanceof LexerError ? e.start : e.span.start;
        const end = e instanceof LexerError ? e.end : e.span.end;
        out.push({ kind: "offset", message: e.message, start, end: Math.max(end, start + 1) });
      } else {
        out.push({ kind: "line", message: e instanceof Error ? e.message : String(e), line: 1 });
      }
      return null;
    }
  }
}
