import {
  CompletionItem,
  CompletionItemKind,
  Hover,
  Location,
  MarkupKind,
  Position,
  Range,
  RenameParams,
  SemanticTokens,
  SemanticTokensBuilder,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Lexer } from "./language/lexer";
import { Parser } from "./language/parser";
import {
  CatchClause,
  CommandDecl,
  Expression,
  Param,
  Span,
  Statement,
  TypeRef,
} from "./language/ast";
import { DefaultBuiltinTypeProvider } from "./language/builtins";
import { STANDARD_MODULE_TYPES } from "./language/stdlib";
import {
  JetType,
  TCallable,
  TCommand,
  TInterval,
  TListener,
  TModule,
  TUnknown,
  paramsToCallSignature,
  typeRefToJetType,
  typeToString,
} from "./language/types";
import { collectExportDefinitions, displayPath, ScriptModule } from "./language/module";
import { SourceDocument } from "./analysis";
import { Token, TokenType } from "./language/token";

export const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "function",
  "method",
  "property",
  "variable",
  "parameter",
  "keyword",
  "string",
  "number",
  "event",
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "readonly",
  "defaultLibrary",
] as const;

type SymbolRole = "function" | "method" | "variable" | "parameter" | "constant" | "module" | "event" | "type";

interface IndexedSymbol {
  id: number;
  name: string;
  uri: string;
  range: Span;
  selection: Span;
  role: SymbolRole;
  detail: string;
  type: JetType;
  scopeId: number;
  readonly: boolean;
  builtin: boolean;
}

interface Occurrence {
  name: string;
  uri: string;
  range: Span;
  symbolId: number | null;
  role: SymbolRole | "property";
  declaration: boolean;
}

interface Scope {
  id: number;
  uri: string;
  parentId: number | null;
  start: number;
  end: number;
  symbols: Map<string, number>;
}

interface ParsedDocument {
  uri: string;
  text: string;
  document: TextDocument;
  statements: Statement[];
  tokens: Token[];
}

export interface IndexSourceDocument extends SourceDocument {
  pathSegments: string[];
}

export class SymbolIndex {
  private readonly symbols: IndexedSymbol[] = [];
  private readonly occurrences: Occurrence[] = [];
  private readonly scopes = new Map<number, Scope>();
  private readonly docs = new Map<string, ParsedDocument>();
  private readonly modulesByPath = new Map<string, ScriptModule>();
  private readonly moduleTypesByRoot = new Map<string, JetType>();
  private readonly builtinTypeProvider = new DefaultBuiltinTypeProvider();
  private nextSymbolId = 1;
  private nextScopeId = 1;

  static fromDocuments(documents: IndexSourceDocument[]): SymbolIndex {
    const index = new SymbolIndex();
    index.build(documents);
    return index;
  }

  completion(uri: string, offset: number): CompletionItem[] {
    const parsed = this.docs.get(uri);
    if (parsed === undefined) return [];

    const memberTarget = memberTargetBefore(parsed.text, offset);
    if (memberTarget !== null) return this.memberCompletions(uri, offset, memberTarget);

    const usingPrefix = usingPrefixBefore(parsed.text, offset);
    if (usingPrefix !== null) return this.usingCompletions(usingPrefix);

    const items = new Map<string, CompletionItem>();
    for (const symbol of this.visibleSymbols(uri, offset)) {
      items.set(symbol.name, {
        label: symbol.name,
        kind: completionKind(symbol.role),
        detail: symbol.detail,
      });
    }
    for (const [name, type] of this.moduleTypesByRoot) {
      items.set(name, { label: name, kind: CompletionItemKind.Module, detail: typeToString(type) });
    }
    for (const name of this.builtinTypeProvider.globalNames()) {
      items.set(name, { label: name, kind: CompletionItemKind.Function, detail: "builtin" });
    }
    return [...items.values()].sort(compareCompletionItems);
  }

  hover(uri: string, position: Position): Hover | null {
    const occurrence = this.occurrenceAtPosition(uri, position);
    if (occurrence === null) return null;
    const symbol = occurrence.symbolId !== null ? this.symbolById(occurrence.symbolId) : null;
    if (symbol === null) return null;
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: "```jetpack\n" + symbol.detail + "\n```",
      },
      range: this.toRange(uri, occurrence.range),
    };
  }

  definition(uri: string, position: Position): Location | null {
    const occurrence = this.occurrenceAtPosition(uri, position);
    if (occurrence?.symbolId == null) return null;
    const symbol = this.symbolById(occurrence.symbolId);
    if (symbol === null || symbol.builtin) return null;
    return Location.create(symbol.uri, this.toRange(symbol.uri, symbol.selection));
  }

  references(uri: string, position: Position, includeDeclaration: boolean): Location[] {
    const occurrence = this.occurrenceAtPosition(uri, position);
    if (occurrence?.symbolId == null) return [];
    return this.occurrences
      .filter((entry) => entry.symbolId === occurrence.symbolId && (includeDeclaration || !entry.declaration))
      .map((entry) => Location.create(entry.uri, this.toRange(entry.uri, entry.range)));
  }

  prepareRename(uri: string, position: Position): Range | null {
    const occurrence = this.occurrenceAtPosition(uri, position);
    if (occurrence?.symbolId == null) return null;
    const symbol = this.symbolById(occurrence.symbolId);
    if (symbol === null || symbol.builtin) return null;
    return this.toRange(uri, occurrence.range);
  }

  rename(params: RenameParams): WorkspaceEdit | null {
    if (!isValidIdentifier(params.newName)) return null;
    const occurrence = this.occurrenceAtPosition(params.textDocument.uri, params.position);
    if (occurrence?.symbolId == null) return null;
    const symbol = this.symbolById(occurrence.symbolId);
    if (symbol === null || symbol.builtin) return null;

    const changes = new Map<string, TextEdit[]>();
    for (const entry of this.occurrences.filter((item) => item.symbolId === occurrence.symbolId)) {
      const edits = changes.get(entry.uri) ?? [];
      edits.push(TextEdit.replace(this.toRange(entry.uri, entry.range), params.newName));
      changes.set(entry.uri, edits);
    }

    return {
      changes: Object.fromEntries([...changes].map(([entryUri, edits]) => [entryUri, edits])),
    };
  }

  semanticTokens(uri: string): SemanticTokens {
    const parsed = this.docs.get(uri);
    const builder = new SemanticTokensBuilder();
    if (parsed === undefined) return builder.build();

    for (const token of parsed.tokens) {
      const tokenType = tokenTypeFor(token);
      if (tokenType !== null) this.pushToken(builder, parsed.document, token.start, token.end, tokenType, 0);
    }

    for (const occurrence of this.occurrences.filter((entry) => entry.uri === uri)) {
      const tokenType = semanticTypeFor(occurrence.role);
      const modifiers = occurrence.declaration ? 1 : 0;
      this.pushToken(builder, parsed.document, occurrence.range.start, occurrence.range.end, tokenType, modifiers);
    }

    return builder.build();
  }

  private build(documents: IndexSourceDocument[]): void {
    for (const doc of documents) {
      const parsed = parseDocument(doc);
      if (parsed === null) continue;
      this.docs.set(doc.uri, parsed);
      const module: ScriptModule = {
        uri: doc.uri,
        pathSegments: doc.pathSegments,
        stmts: parsed.statements,
        sourceLines: doc.text.split("\n"),
        exportDefinitions: collectExportDefinitions(parsed.statements),
        resolvedImports: [],
        validationState: null,
      };
      this.modulesByPath.set(displayPath(module), module);
    }

    for (const doc of this.docs.values()) {
      this.indexDocument(doc);
    }

    this.buildModuleTypes();
  }

  private indexDocument(parsed: ParsedDocument): void {
    const rootScope = this.createScope(parsed.uri, null, 0, parsed.text.length);
    for (const [name, type] of STANDARD_MODULE_TYPES) {
      const symbol = this.addSymbol({
        name,
        uri: parsed.uri,
        range: { start: 0, end: 0 },
        selection: { start: 0, end: 0 },
        role: "module",
        detail: `module ${name}`,
        type: type.dynamic ? TUnknown : TModule(type.fields),
        scopeId: rootScope.id,
        readonly: true,
        builtin: true,
      });
      rootScope.symbols.set(name, symbol.id);
    }
    for (const name of this.builtinTypeProvider.globalNames()) {
      const type = this.builtinTypeProvider.globalType(name) ?? TUnknown;
      const symbol = this.addSymbol({
        name,
        uri: parsed.uri,
        range: { start: 0, end: 0 },
        selection: { start: 0, end: 0 },
        role: "function",
        detail: `builtin ${name}: ${typeToString(type)}`,
        type,
        scopeId: rootScope.id,
        readonly: true,
        builtin: true,
      });
      rootScope.symbols.set(name, symbol.id);
    }

    for (const stmt of parsed.statements) this.hoistDeclaration(parsed.uri, rootScope, stmt);
    for (const stmt of parsed.statements) this.indexStatement(parsed.uri, stmt, rootScope);
  }

  private hoistDeclaration(uri: string, scope: Scope, stmt: Statement): void {
    switch (stmt.kind) {
      case "FunctionDecl":
        this.declare(scope, uri, stmt.name, stmt.nameSpan, "function", `function ${stmt.name}`, functionType(stmt.params, stmt.returnType), true, false);
        break;
      case "IntervalDecl":
        this.declare(scope, uri, stmt.name, stmt.nameSpan, "event", `interval ${stmt.name}`, TInterval, true, false);
        break;
      case "ListenerDecl":
        this.declare(scope, uri, stmt.name, stmt.nameSpan, "event", `listener ${stmt.eventType} ${stmt.name}`, TListener, true, false);
        break;
      case "CommandDecl":
        this.declare(scope, uri, stmt.name, stmt.nameSpan, "method", `command ${stmt.name}`, TCommand, true, false);
        break;
      default:
        break;
    }
  }

  private indexStatement(uri: string, stmt: Statement, scope: Scope): void {
    switch (stmt.kind) {
      case "Metadata":
      case "Manifest":
      case "Using":
      case "BreakStmt":
      case "ContinueStmt":
        return;
      case "VarDecl":
        this.indexExpression(uri, stmt.initializer, scope);
        this.declare(scope, uri, stmt.name, stmt.nameSpan, stmt.isConst ? "constant" : "variable", `${stmt.isConst ? "const" : "var"} ${stmt.name}: ${typeRefDetail(stmt.typeName)}`, typeRefToJetType(stmt.typeName), stmt.isConst, false);
        return;
      case "ExprStatement":
        this.indexExpression(uri, stmt.expression, scope);
        return;
      case "FunctionDecl": {
        const bodyScope = this.createScopeForStatements(uri, scope.id, stmt.body, stmt.span);
        for (const param of stmt.params) this.declareParam(uri, bodyScope, param);
        for (const bodyStmt of stmt.body) this.indexStatement(uri, bodyStmt, bodyScope);
        return;
      }
      case "IntervalDecl":
        this.indexBlock(uri, stmt.body, scope, blockSpan(stmt.body, stmt.span));
        return;
      case "ListenerDecl": {
        const bodyScope = this.createScopeForStatements(uri, scope.id, stmt.body, stmt.span);
        if (stmt.senderParam !== null && stmt.senderParamSpan !== null) {
          this.declare(bodyScope, uri, stmt.senderParam, stmt.senderParamSpan, "parameter", `parameter ${stmt.senderParam}: object`, TUnknown, false, false);
        }
        for (const bodyStmt of stmt.body) this.indexStatement(uri, bodyStmt, bodyScope);
        return;
      }
      case "IfStmt":
        this.indexExpression(uri, stmt.condition, scope);
        this.indexBlock(uri, stmt.thenBody, scope, blockSpan(stmt.thenBody, stmt.span));
        for (const clause of stmt.elseIfClauses) {
          this.indexExpression(uri, clause.condition, scope);
          this.indexBlock(uri, clause.body, scope, blockSpan(clause.body, stmt.span));
        }
        if (stmt.elseBody !== null) this.indexBlock(uri, stmt.elseBody, scope, blockSpan(stmt.elseBody, stmt.span));
        return;
      case "WhileStmt":
        this.indexExpression(uri, stmt.condition, scope);
        this.indexBlock(uri, stmt.body, scope, blockSpan(stmt.body, stmt.span));
        return;
      case "ForEachStmt": {
        this.indexExpression(uri, stmt.iterable, scope);
        const bodyScope = this.createScopeForStatements(uri, scope.id, stmt.body, stmt.span);
        this.declare(bodyScope, uri, stmt.itemName, stmt.itemNameSpan, "variable", `var ${stmt.itemName}`, typeRefToJetType(stmt.itemType ?? { name: "var", typeArgRef: null, span: stmt.itemNameSpan }), false, false);
        for (const bodyStmt of stmt.body) this.indexStatement(uri, bodyStmt, bodyScope);
        return;
      }
      case "TryStmt":
        this.indexBlock(uri, stmt.tryBody, scope, blockSpan(stmt.tryBody, stmt.span));
        for (const catchClause of stmt.catches) this.indexCatch(uri, catchClause, scope);
        if (stmt.finallyBody !== null) this.indexBlock(uri, stmt.finallyBody, scope, blockSpan(stmt.finallyBody, stmt.span));
        return;
      case "ReturnStmt":
        if (stmt.value !== null) this.indexExpression(uri, stmt.value, scope);
        return;
      case "CommandDecl":
        this.indexCommand(uri, stmt, scope);
        return;
      case "Deconstruction":
        this.indexExpression(uri, stmt.initializer, scope);
        for (const binding of stmt.bindings) {
          if (binding.name === null) continue;
          if (stmt.isDeclaration) {
            const nameSpan = binding.nameSpan ?? binding.span;
            this.declare(scope, uri, binding.name, nameSpan, stmt.isConst ? "constant" : "variable", `${stmt.isConst ? "const" : "var"} ${binding.name}`, typeRefToJetType(binding.typeName ?? { name: "var", typeArgRef: null, span: nameSpan }), stmt.isConst, false);
          } else {
            this.addReference(uri, binding.name, binding.nameSpan ?? binding.span, scope, "variable");
          }
        }
        return;
    }
  }

  private indexBlock(uri: string, stmts: Statement[], parent: Scope, span: Span): void {
    const scope = this.createScope(uri, parent.id, span.start, span.end);
    for (const stmt of stmts) this.indexStatement(uri, stmt, scope);
  }

  private indexCatch(uri: string, catchClause: CatchClause, parent: Scope): void {
    const scope = this.createScopeForStatements(uri, parent.id, catchClause.body, catchClause.span);
    if (catchClause.variableName !== null && catchClause.variableNameSpan !== null) {
      this.declare(scope, uri, catchClause.variableName, catchClause.variableNameSpan, "parameter", `catch ${catchClause.variableName}`, TUnknown, false, false);
    }
    for (const stmt of catchClause.body) this.indexStatement(uri, stmt, scope);
  }

  private indexCommand(uri: string, command: CommandDecl, parent: Scope): void {
    const commandBody = command.bodyItems.flatMap((item) => {
      if (item.kind === "code") return [item.stmt];
      if (item.kind === "default") return item.body;
      return [item.decl];
    });
    const scope = this.createScopeForStatements(uri, parent.id, commandBody, command.span);
    if (command.senderName !== null && command.senderNameSpan !== null) {
      this.declare(scope, uri, command.senderName, command.senderNameSpan, "parameter", `parameter ${command.senderName}: object`, TUnknown, false, false);
    }
    for (const param of command.params) this.declareParam(uri, scope, param);
    for (const item of command.bodyItems) {
      if (item.kind === "code") this.indexStatement(uri, item.stmt, scope);
      else if (item.kind === "default") this.indexBlock(uri, item.body, scope, blockSpan(item.body, command.span));
      else this.indexCommand(uri, item.decl, scope);
    }
  }

  private indexExpression(uri: string, expr: Expression, scope: Scope): void {
    switch (expr.kind) {
      case "Identifier":
        this.addReference(uri, expr.name, expr.span, scope, "variable");
        return;
      case "MemberAccess":
        this.indexExpression(uri, expr.target, scope);
        this.addOccurrence({ name: expr.member, uri, range: expr.memberSpan, symbolId: null, role: "property", declaration: false });
        return;
      case "Call":
        this.indexExpression(uri, expr.callee, scope);
        for (const arg of expr.arguments) this.indexExpression(uri, arg, scope);
        return;
      case "ThreadCall":
        this.indexExpression(uri, expr.call, scope);
        return;
      case "ThreadBlock":
        this.indexStatement(uri, expr.statement, scope);
        return;
      case "BinaryOp":
        this.indexExpression(uri, expr.left, scope);
        this.indexExpression(uri, expr.right, scope);
        return;
      case "UnaryOp":
        this.indexExpression(uri, expr.operand, scope);
        return;
      case "Ternary":
        this.indexExpression(uri, expr.condition, scope);
        this.indexExpression(uri, expr.thenExpr, scope);
        this.indexExpression(uri, expr.elseExpr, scope);
        return;
      case "Range":
        this.indexExpression(uri, expr.start, scope);
        this.indexExpression(uri, expr.end, scope);
        return;
      case "IndexAccess":
        this.indexExpression(uri, expr.target, scope);
        this.indexExpression(uri, expr.index, scope);
        return;
      case "Assign":
        this.indexExpression(uri, expr.target, scope);
        this.indexExpression(uri, expr.value, scope);
        return;
      case "CompoundAssign":
        this.indexExpression(uri, expr.target, scope);
        this.indexExpression(uri, expr.value, scope);
        return;
      case "ListLiteral":
        for (const element of expr.elements) this.indexExpression(uri, element, scope);
        return;
      case "ObjectLiteral":
        for (const entry of expr.entries) this.indexExpression(uri, entry.value, scope);
        return;
      case "InterpolatedString":
        for (const part of expr.parts) {
          if (part.kind === "expr") this.indexExpression(uri, part.expression, scope);
        }
        return;
      case "IntLiteral":
      case "FloatLiteral":
      case "StringLiteral":
      case "BoolLiteral":
      case "NullLiteral":
        return;
    }
  }

  private declareParam(uri: string, scope: Scope, param: Param): void {
    this.declare(scope, uri, param.name, param.nameSpan, "parameter", `parameter ${param.name}: ${param.typeName ? typeRefDetail(param.typeName) : "var"}`, typeRefToJetType(param.typeName ?? { name: "var", typeArgRef: null, span: param.nameSpan }), false, false);
    if (param.default !== null) this.indexExpression(uri, param.default, scope);
  }

  private declare(scope: Scope, uri: string, name: string, range: Span, role: SymbolRole, detail: string, type: JetType, readonly: boolean, builtin: boolean): IndexedSymbol {
    const existing = scope.symbols.get(name);
    if (existing !== undefined) return this.symbolById(existing)!;
    const symbol = this.addSymbol({
      name,
      uri,
      range,
      selection: range,
      role,
      detail,
      type,
      scopeId: scope.id,
      readonly,
      builtin,
    });
    scope.symbols.set(name, symbol.id);
    if (!builtin) this.addOccurrence({ name, uri, range, symbolId: symbol.id, role, declaration: true });
    return symbol;
  }

  private addReference(uri: string, name: string, range: Span, scope: Scope, fallbackRole: SymbolRole): void {
    const symbolId = this.resolveSymbolId(name, scope);
    const symbol = symbolId !== null ? this.symbolById(symbolId) : null;
    this.addOccurrence({
      name,
      uri,
      range,
      symbolId,
      role: symbol?.role ?? fallbackRole,
      declaration: false,
    });
  }

  private resolveSymbolId(name: string, scope: Scope): number | null {
    let current: Scope | undefined = scope;
    while (current !== undefined) {
      const symbolId = current.symbols.get(name);
      if (symbolId !== undefined) return symbolId;
      current = current.parentId !== null ? this.scopes.get(current.parentId) : undefined;
    }
    return null;
  }

  private createScope(uri: string, parentId: number | null, start: number, end: number): Scope {
    const scope: Scope = { id: this.nextScopeId++, uri, parentId, start, end, symbols: new Map() };
    this.scopes.set(scope.id, scope);
    return scope;
  }

  private createScopeForStatements(uri: string, parentId: number | null, statements: Statement[], fallback: Span): Scope {
    const span = blockSpan(statements, fallback);
    return this.createScope(uri, parentId, span.start, span.end);
  }

  private addSymbol(symbol: Omit<IndexedSymbol, "id">): IndexedSymbol {
    const indexed: IndexedSymbol = { id: this.nextSymbolId++, ...symbol };
    this.symbols.push(indexed);
    return indexed;
  }

  private addOccurrence(occurrence: Occurrence): void {
    this.occurrences.push(occurrence);
  }

  private buildModuleTypes(): void {
    for (const module of this.modulesByPath.values()) {
      if (module.pathSegments.length === 0) continue;
      const root = module.pathSegments[0];
      const existing = this.moduleTypesByRoot.get(root);
      const fields = existing?.kind === "module" ? new Map(existing.fields) : new Map<string, JetType>();
      addModuleFields(fields, module.pathSegments.slice(1), module);
      this.moduleTypesByRoot.set(root, TModule(fields));
    }
  }

  private memberCompletions(uri: string, offset: number, targetName: string): CompletionItem[] {
    const scope = this.scopeAt(uri, offset);
    const symbolId = scope !== null ? this.resolveSymbolId(targetName, scope) : null;
    const symbol = symbolId !== null ? this.symbolById(symbolId) : null;
    const type = symbol?.type ?? this.moduleTypesByRoot.get(targetName) ?? null;
    if (type === null) return [];
    const fields = type.kind === "module" ? type.fields : null;
    if (fields === null) return [];
    return [...fields].map(([label, fieldType]) => ({
      label,
      kind: fieldType.kind === "callable" ? CompletionItemKind.Function : CompletionItemKind.Property,
      detail: typeToString(fieldType),
    })).sort(compareCompletionItems);
  }

  private usingCompletions(prefix: string): CompletionItem[] {
    const labels = new Set<string>();
    for (const name of STANDARD_MODULE_TYPES.keys()) labels.add(name);
    for (const module of this.modulesByPath.values()) labels.add(displayPath(module));
    return [...labels]
      .filter((label) => label.startsWith(prefix))
      .map((label) => ({ label, kind: CompletionItemKind.Module }))
      .sort(compareCompletionItems);
  }

  private visibleSymbols(uri: string, offset: number): IndexedSymbol[] {
    const scope = this.scopeAt(uri, offset);
    if (scope === null) return [];
    const result = new Map<string, IndexedSymbol>();
    let current: Scope | undefined = scope;
    while (current !== undefined) {
      for (const [name, id] of current.symbols) {
        if (!result.has(name)) result.set(name, this.symbolById(id)!);
      }
      current = current.parentId !== null ? this.scopes.get(current.parentId) : undefined;
    }
    return [...result.values()];
  }

  private scopeAt(uri: string, offset: number): Scope | null {
    const matches = [...this.scopes.values()].filter((scope) =>
      scope.uri === uri && scope.start <= offset && offset <= scope.end,
    );
    return matches.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
  }

  private occurrenceAtPosition(uri: string, position: Position): Occurrence | null {
    const parsed = this.docs.get(uri);
    if (parsed === undefined) return null;
    const offset = parsed.document.offsetAt(position);
    return this.occurrences
      .filter((entry) => entry.uri === uri && entry.range.start <= offset && offset < entry.range.end)
      .sort((a, b) => spanLength(a.range) - spanLength(b.range))[0] ?? null;
  }

  private symbolById(id: number): IndexedSymbol | null {
    return this.symbols.find((symbol) => symbol.id === id) ?? null;
  }

  private toRange(uri: string, span: Span): Range {
    const parsed = this.docs.get(uri);
    if (parsed === undefined) return Range.create(0, 0, 0, 0);
    return Range.create(parsed.document.positionAt(span.start), parsed.document.positionAt(span.end));
  }

  private pushToken(builder: SemanticTokensBuilder, document: TextDocument, start: number, end: number, type: string, modifiers: number): void {
    const position = document.positionAt(start);
    builder.push(position.line, position.character, Math.max(1, end - start), SEMANTIC_TOKEN_TYPES.indexOf(type as typeof SEMANTIC_TOKEN_TYPES[number]), modifiers);
  }
}

function parseDocument(doc: IndexSourceDocument): ParsedDocument | null {
  try {
    const document = TextDocument.create(doc.uri, "jetpack", 0, doc.text);
    const tokens = new Lexer(doc.text).tokenize();
    const statements = new Parser(tokens).parseFile();
    return { uri: doc.uri, text: doc.text, document, statements, tokens };
  } catch {
    return null;
  }
}

function functionType(params: Param[], returnType: TypeRef | null): JetType {
  const resolvedReturnType = returnType !== null ? typeRefToJetType(returnType) : TUnknown;
  return TCallable(resolvedReturnType, [{ ...paramsToCallSignature(params), returnType: resolvedReturnType }]);
}

function typeRefDetail(ref: TypeRef): string {
  return ref.typeArgRef === null ? ref.name : `${ref.name}<${typeRefDetail(ref.typeArgRef)}>`;
}

function addModuleFields(fields: Map<string, JetType>, segments: string[], module: ScriptModule): void {
  if (segments.length === 0) {
    for (const [name, definition] of module.exportDefinitions) {
      if (definition.access !== "private") fields.set(name, definition.type);
    }
    return;
  }
  const [head, ...tail] = segments;
  const existing = fields.get(head);
  const childFields = existing?.kind === "module" ? new Map(existing.fields) : new Map<string, JetType>();
  addModuleFields(childFields, tail, module);
  fields.set(head, TModule(childFields));
}

function tokenTypeFor(token: Token): string | null {
  if (token.type === TokenType.EOF || token.type === TokenType.NEWLINE) return null;
  if (token.type === TokenType.STRING_LITERAL || token.type === TokenType.INTERP_STRING) return "string";
  if (token.type === TokenType.INT_LITERAL || token.type === TokenType.FLOAT_LITERAL) return "number";
  if (token.type === TokenType.IDENTIFIER || token.type === TokenType.BOOL_LITERAL) return null;
  return token.type.toString().startsWith("KW_") ? "keyword" : null;
}

function semanticTypeFor(role: Occurrence["role"]): string {
  switch (role) {
    case "function": return "function";
    case "method": return "method";
    case "module": return "namespace";
    case "parameter": return "parameter";
    case "property": return "property";
    case "event": return "event";
    case "type": return "type";
    case "constant":
    case "variable":
    default:
      return "variable";
  }
}

function completionKind(role: SymbolRole): CompletionItemKind {
  switch (role) {
    case "function": return CompletionItemKind.Function;
    case "method": return CompletionItemKind.Method;
    case "module": return CompletionItemKind.Module;
    case "parameter": return CompletionItemKind.Variable;
    case "constant": return CompletionItemKind.Constant;
    case "event": return CompletionItemKind.Event;
    case "type": return CompletionItemKind.Class;
    case "variable":
    default:
      return CompletionItemKind.Variable;
  }
}

function memberTargetBefore(text: string, offset: number): string | null {
  const prefix = text.slice(0, offset);
  const match = /([A-Za-z_\p{L}][A-Za-z0-9_\p{L}]*)\.\s*$/u.exec(prefix);
  return match?.[1] ?? null;
}

function usingPrefixBefore(text: string, offset: number): string | null {
  const prefix = text.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const line = prefix.slice(lineStart);
  const match = /^\s*using\s+([A-Za-z0-9_.$]*)$/u.exec(line);
  return match?.[1].replace(/^\.+/, "") ?? null;
}

function compareCompletionItems(a: CompletionItem, b: CompletionItem): number {
  return a.label.localeCompare(b.label);
}

function spanLength(span: Span): number {
  return span.end - span.start;
}

function blockSpan(statements: Statement[], fallback: Span): Span {
  if (statements.length === 0) return fallback;
  return {
    start: Math.min(...statements.map((stmt) => stmt.span.start)),
    end: Math.max(...statements.map((stmt) => stmt.span.end)),
  };
}

function isValidIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  if (!isIdentifierStart(value[0])) return false;
  for (let i = 1; i < value.length; i++) {
    if (!isIdentifierPart(value[i])) return false;
  }
  return true;
}

function isIdentifierStart(ch: string): boolean {
  return ch === "_" || /\p{L}/u.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}
