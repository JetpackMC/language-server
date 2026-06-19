import { TextEdit, Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Lexer } from "./lexer";
import { Token, TokenType } from "./token";

const INDENT_UNIT = "  ";
const OPENERS: ReadonlySet<TokenType> = new Set([TokenType.LBRACE, TokenType.LBRACKET, TokenType.LPAREN]);
const CLOSERS: ReadonlySet<TokenType> = new Set([TokenType.RBRACE, TokenType.RBRACKET, TokenType.RPAREN]);

export function formatDocument(document: TextDocument): TextEdit[] {
  return formatLineRange(document, 0, document.lineCount - 1);
}

export function formatRange(document: TextDocument, range: Range): TextEdit[] {
  return formatLineRange(document, range.start.line, range.end.line);
}

export function formatOnType(document: TextDocument, line: number): TextEdit[] {
  return formatLineRange(document, line, line);
}

function formatLineRange(document: TextDocument, fromLine: number, toLine: number): TextEdit[] {
  const indents = computeLineIndents(document);
  if (indents === null) return [];

  const edits: TextEdit[] = [];
  for (let line = fromLine; line <= toLine && line < document.lineCount; line++) {
    const edit = lineEdit(document, line, indents[line] ?? 0);
    if (edit !== null) edits.push(edit);
  }
  return edits;
}

function lineEdit(document: TextDocument, line: number, indentLevel: number): TextEdit | null {
  const text = lineText(document, line);
  const trimmed = text.replace(/\s+$/, "");
  const formatted = trimmed.trim().length === 0 ? "" : INDENT_UNIT.repeat(indentLevel) + trimmed.trimStart();
  if (formatted === text) return null;
  return TextEdit.replace(Range.create(line, 0, line, text.length), formatted);
}

function lineText(document: TextDocument, line: number): string {
  return document.getText(Range.create(line, 0, line + 1, 0)).replace(/\r?\n$/, "");
}

function computeLineIndents(document: TextDocument): number[] | null {
  let tokens: Token[];
  try {
    tokens = new Lexer(document.getText()).tokenize();
  } catch {
    return null;
  }

  const realTokens = tokens.filter((token) => token.type !== TokenType.NEWLINE && token.type !== TokenType.EOF);
  const indents = new Array<number>(document.lineCount).fill(0);
  let depth = 0;
  let tokenIndex = 0;
  for (let line = 0; line < document.lineCount; line++) {
    const startDepth = depth;
    let firstIsCloser: boolean | null = null;
    while (tokenIndex < realTokens.length && realTokens[tokenIndex].line - 1 === line) {
      const token = realTokens[tokenIndex];
      if (firstIsCloser === null) firstIsCloser = CLOSERS.has(token.type);
      if (OPENERS.has(token.type)) depth++;
      else if (CLOSERS.has(token.type)) depth = Math.max(0, depth - 1);
      tokenIndex++;
    }
    indents[line] = Math.max(0, startDepth - (firstIsCloser === true ? 1 : 0));
  }
  return indents;
}
