import {
  CompletionItem,
  CompletionItemKind,
  DocumentSymbol,
  SymbolKind,
  Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Lexer } from "./language/lexer";
import { Parser } from "./language/parser";
import { CommandDecl, Span, Statement } from "./language/ast";
import { KNOWN_EVENTS } from "./language/events";
import { DefaultBuiltinTypeProvider } from "./language/builtins";
import { SymbolIndex } from "./symbolIndex";

const KEYWORDS = [
  "int", "float", "string", "bool", "list", "object", "var", "null", "true", "false",
  "function", "return", "const", "public", "private", "protected",
  "if", "else", "while", "foreach", "in", "break", "continue",
  "try", "catch", "finally", "thread", "to", "until",
  "interval", "schedule", "listener", "command", "default", "using", "as", "manifest", "enum",
];

const BUILTIN_GLOBALS = [...new DefaultBuiltinTypeProvider().globalNames()];

const LISTENER_CONTEXT = /\blistener\s+[A-Za-z_]*$/;
const ANNOTATION_CONTEXT = /^\s*@[\w-]*$/;

const ANNOTATIONS = [
  "priority",
  "ignoreCancelled",
  "description",
  "permission",
  "permissionMessage",
  "usage",
  "aliases",
  "placeholder",
];

export function completion(document: TextDocument, offset: number, index: SymbolIndex | null = null): CompletionItem[] {
  const prefix = document.getText().slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const linePrefix = prefix.slice(lineStart);

  if (LISTENER_CONTEXT.test(linePrefix)) {
    return [...KNOWN_EVENTS].map((name) => ({ label: name, kind: CompletionItemKind.Event }));
  }

  if (ANNOTATION_CONTEXT.test(linePrefix)) {
    return ANNOTATIONS.map((label) => ({ label, kind: CompletionItemKind.Property }));
  }

  const text = document.getText();
  const items: CompletionItem[] = index?.completion(document.uri, offset, text) ?? [];
  if (isMemberCompletion(text, offset)) return items;

  const existingLabels = new Set(items.map((item) => item.label));
  for (const label of KEYWORDS) {
    if (!existingLabels.has(label)) items.push({ label, kind: CompletionItemKind.Keyword });
  }
  for (const label of BUILTIN_GLOBALS) {
    if (!existingLabels.has(label)) items.push({ label, kind: CompletionItemKind.Function });
  }
  return items;
}

export function documentSymbols(document: TextDocument): DocumentSymbol[] {
  let stmts: Statement[];
  try {
    stmts = new Parser(new Lexer(document.getText()).tokenize()).parseFile();
  } catch {
    return [];
  }
  const symbols: DocumentSymbol[] = [];
  for (const stmt of stmts) {
    const symbol = toSymbol(document, stmt);
    if (symbol !== null) symbols.push(symbol);
  }
  return symbols;
}

function toSymbol(document: TextDocument, stmt: Statement): DocumentSymbol | null {
  switch (stmt.kind) {
    case "FunctionDecl":
      return symbol(document, stmt.name, SymbolKind.Function, stmt.span, stmt.nameSpan);
    case "IntervalDecl":
      return symbol(document, stmt.name, SymbolKind.Event, stmt.span, stmt.nameSpan);
    case "ScheduleDecl":
      return symbol(document, stmt.name, SymbolKind.Event, stmt.span, stmt.nameSpan);
    case "EnumDecl":
      return symbol(document, stmt.name, SymbolKind.Enum, stmt.span, stmt.nameSpan);
    case "ListenerDecl":
      return symbol(document, `${stmt.name} (${stmt.eventType})`, SymbolKind.Event, stmt.span, stmt.nameSpan);
    case "CommandDecl":
      return commandSymbol(document, stmt);
    case "VarDecl":
      return symbol(
        document,
        stmt.name,
        stmt.isConst ? SymbolKind.Constant : SymbolKind.Variable,
        stmt.span,
        stmt.nameSpan,
      );
    default:
      return null;
  }
}

function commandSymbol(document: TextDocument, decl: CommandDecl): DocumentSymbol {
  const node = symbol(document, decl.name, SymbolKind.Method, decl.span, decl.nameSpan);
  const children: DocumentSymbol[] = [];
  for (const item of decl.bodyItems) {
    if (item.kind === "subcommand") children.push(commandSymbol(document, item.decl));
  }
  if (children.length > 0) node.children = children;
  return node;
}

function symbol(
  document: TextDocument,
  name: string,
  kind: SymbolKind,
  span: Span,
  nameSpan: Span,
): DocumentSymbol {
  return {
    name,
    kind,
    range: toRange(document, span),
    selectionRange: toRange(document, nameSpan),
  };
}

function toRange(document: TextDocument, span: Span): Range {
  return { start: document.positionAt(span.start), end: document.positionAt(span.end) };
}

function isMemberCompletion(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset);
  return /([A-Za-z_\p{L}][A-Za-z0-9_\p{L}]*)\.\s*$/u.test(prefix);
}
