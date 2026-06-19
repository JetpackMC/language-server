import { Lexer } from "./lexer";
import { Token, TokenType } from "./token";
import {
  AccessModifier,
  CatchClause,
  Call,
  CommandAnnotations,
  CommandBodyItem,
  CommandDecl,
  DeconstructionBinding,
  EMPTY_COMMAND_ANNOTATIONS,
  EMPTY_LISTENER_ANNOTATIONS,
  EnumValue,
  Expression,
  InterpolationPart,
  ListenerAnnotations,
  ManifestValue,
  Metadata,
  ObjectEntry,
  Param,
  Span,
  Statement,
  TypeRef,
} from "./ast";

export class ParseError extends Error {
  constructor(message: string, readonly line: number, readonly span: Span) {
    super(message);
    this.name = "ParseError";
  }
}

const TYPE_KEYWORDS: ReadonlySet<TokenType> = new Set([
  TokenType.KW_INT, TokenType.KW_FLOAT, TokenType.KW_STRING, TokenType.KW_BOOL,
  TokenType.KW_LIST, TokenType.KW_OBJECT, TokenType.KW_VAR,
]);
const ASSIGNMENT_OPERATORS: ReadonlySet<TokenType> = new Set([
  TokenType.EQ, TokenType.PLUS_ASSIGN, TokenType.MINUS_ASSIGN, TokenType.STAR_ASSIGN,
  TokenType.SLASH_ASSIGN, TokenType.PERCENT_ASSIGN, TokenType.STAR_STAR_ASSIGN,
]);
const ACCESS_MODIFIERS: ReadonlySet<TokenType> = new Set([
  TokenType.KW_PUBLIC, TokenType.KW_PRIVATE, TokenType.KW_PROTECTED,
]);
const EQUALITY_OPS: ReadonlySet<TokenType> = new Set([TokenType.EQ_EQ, TokenType.BANG_EQ]);
const COMPARISON_OPS: ReadonlySet<TokenType> = new Set([TokenType.LT, TokenType.LT_EQ, TokenType.GT, TokenType.GT_EQ]);
const ADD_SUB_OPS: ReadonlySet<TokenType> = new Set([TokenType.PLUS, TokenType.MINUS]);
const MUL_DIV_OPS: ReadonlySet<TokenType> = new Set([TokenType.STAR, TokenType.SLASH, TokenType.PERCENT]);
const UNARY_OPS: ReadonlySet<TokenType> = new Set([TokenType.BANG, TokenType.MINUS]);
const PREFIX_INC_DEC_OPS: ReadonlySet<TokenType> = new Set([TokenType.PLUS_PLUS, TokenType.MINUS_MINUS]);

const STATEMENT_START: ReadonlySet<TokenType> = new Set([
  ...TYPE_KEYWORDS,
  TokenType.KW_CONST, TokenType.KW_FUNCTION, TokenType.KW_INTERVAL, TokenType.KW_SCHEDULE,
  TokenType.KW_ENUM, TokenType.KW_LISTENER, TokenType.KW_COMMAND, TokenType.KW_MANIFEST,
  TokenType.KW_USING, TokenType.KW_IF, TokenType.KW_WHILE, TokenType.KW_FOREACH,
  TokenType.KW_TRY, TokenType.KW_RETURN, TokenType.KW_BREAK, TokenType.KW_CONTINUE,
  TokenType.KW_PUBLIC, TokenType.KW_PRIVATE, TokenType.KW_PROTECTED, TokenType.AT,
]);

export class Parser {
  private pos = 0;
  private statementDepth = 0;
  private tolerant = false;
  private readonly errors: ParseError[] = [];
  private pendingCommandAnnotations: CommandAnnotations = EMPTY_COMMAND_ANNOTATIONS;
  private pendingListenerAnnotations: ListenerAnnotations = EMPTY_LISTENER_ANNOTATIONS;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    const i = this.pos + offset;
    return i >= 0 && i < this.tokens.length ? this.tokens[i] : this.tokens[this.tokens.length - 1];
  }
  private peekType(offset = 0): TokenType {
    return this.peek(offset).type;
  }
  private advance(): Token {
    return this.tokens[this.pos++];
  }
  private prev(): Token {
    return this.tokens[this.pos - 1];
  }
  private isAtEnd(): boolean {
    return this.peekType() === TokenType.EOF;
  }
  private check(type: TokenType): boolean {
    return this.peekType() === type;
  }
  private expect(type: TokenType, msg: string): Token {
    if (!this.check(type)) {
      const t = this.peek();
      throw new ParseError(msg, t.line, { start: t.start, end: t.end });
    }
    return this.advance();
  }
  private skipNewlines(): void {
    while (this.check(TokenType.NEWLINE) || this.check(TokenType.SEMICOLON)) this.advance();
  }
  private withNestedStatements<T>(block: () => T): T {
    this.statementDepth++;
    try {
      return block();
    } finally {
      this.statementDepth--;
    }
  }

  private spanFrom(startTok: Token): Span {
    return { start: startTok.start, end: this.prev().end };
  }

  parseFile(): Statement[] {
    const stmts: Statement[] = [];
    this.skipNewlines();
    while (!this.isAtEnd()) {
      const before = this.pos;
      try {
        this.parseTopLevelInto(stmts);
      } catch (e) {
        if (!this.tolerant || !(e instanceof ParseError)) throw e;
        this.errors.push(e);
        this.synchronize(before, false);
      }
      this.skipNewlines();
    }
    return stmts;
  }

  parseFileTolerant(): { stmts: Statement[]; errors: ParseError[] } {
    this.tolerant = true;
    const stmts = this.parseFile();
    return { stmts, errors: this.errors };
  }

  private parseTopLevelInto(stmts: Statement[]): void {
    const pendingMeta: Metadata[] = [];
    while (this.check(TokenType.AT)) {
      pendingMeta.push(this.parseMetadata());
      this.skipNewlines();
    }
    if (this.isAtEnd()) {
      stmts.push(...pendingMeta);
      return;
    }
    if (pendingMeta.length > 0 && this.isCommandDeclarationAhead()) {
      this.pendingCommandAnnotations = this.buildCommandAnnotations(pendingMeta);
    } else if (pendingMeta.length > 0 && this.isListenerDeclarationAhead()) {
      this.pendingListenerAnnotations = this.buildListenerAnnotations(pendingMeta);
    } else {
      stmts.push(...pendingMeta);
    }
    stmts.push(this.parseTopLevelStatement());
  }

  private synchronize(before: number, inBlock: boolean): void {
    if (this.pos === before) this.advance();
    while (!this.isAtEnd()) {
      const type = this.peekType();
      if (type === TokenType.NEWLINE || type === TokenType.SEMICOLON) return;
      if (inBlock && type === TokenType.RBRACE) return;
      if (STATEMENT_START.has(type)) return;
      this.advance();
    }
  }

  private isCommandDeclarationAhead(): boolean {
    let i = this.pos;
    while (i < this.tokens.length && ACCESS_MODIFIERS.has(this.tokens[i].type)) i++;
    return i < this.tokens.length && this.tokens[i].type === TokenType.KW_COMMAND;
  }

  private isListenerDeclarationAhead(): boolean {
    let i = this.pos;
    while (i < this.tokens.length && ACCESS_MODIFIERS.has(this.tokens[i].type)) i++;
    return i < this.tokens.length && this.tokens[i].type === TokenType.KW_LISTENER;
  }

  private buildCommandAnnotations(meta: Metadata[]): CommandAnnotations {
    let description: string | null = null;
    let permission: string | null = null;
    let permissionMessage: string | null = null;
    let usage: string | null = null;
    let aliases: string[] = [];
    const placeholders = new Map<string, { value: string; line: number; span: Span }>();
    for (const m of meta) {
      switch (m.key) {
        case "description": description = m.value; break;
        case "permission": permission = m.value; break;
        case "permission_message": permissionMessage = m.value; break;
        case "usage": usage = m.value; break;
        case "aliases": aliases = this.parseAliasList(m.value); break;
        case "placeholder":
          if (m.target === null) {
            throw new ParseError(
              "Metadata '@placeholder' expects a parameter name and a string literal value",
              m.line,
              m.span,
            );
          }
          if (placeholders.has(m.target)) {
            throw new ParseError(
              `Placeholder for command parameter '${m.target}' is already declared`,
              m.line,
              m.span,
            );
          }
          placeholders.set(m.target, { value: m.value, line: m.line, span: m.span });
          break;
      }
    }
    return { description, permission, permissionMessage, usage, aliases, placeholders };
  }

  private buildListenerAnnotations(meta: Metadata[]): ListenerAnnotations {
    let priority: string | null = null;
    let ignoreCancelled = false;
    for (const m of meta) {
      if (m.key === "priority") priority = m.value;
      else if (m.key === "ignoreCancelled") ignoreCancelled = m.value.trim().toLowerCase() === "true";
    }
    return { priority, ignoreCancelled };
  }

  private parseAliasList(raw: string): string[] {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    const inner =
      trimmed.startsWith("[") && trimmed.endsWith("]")
        ? trimmed.substring(1, trimmed.length - 1)
        : trimmed;
    return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  private parseTopLevelStatement(): Statement {
    switch (this.peekType()) {
      case TokenType.AT: return this.parseMetadata();
      case TokenType.KW_USING: return this.parseUsing();
      default: return this.parseDeclarationOrStatement();
    }
  }

  private parseMetadata(): Metadata {
    const startTok = this.peek();
    this.expect(TokenType.AT, "Expected '@'");
    const key = this.expect(TokenType.IDENTIFIER, "Expected metadata key after '@'").value;
    const target = key === "placeholder"
      ? this.expect(TokenType.IDENTIFIER, "Metadata '@placeholder' expects a parameter name").value
      : null;
    const value = this.expect(
      TokenType.STRING_LITERAL,
      key === "placeholder"
        ? "Metadata '@placeholder' expects a string literal placeholder"
        : `Metadata '@${key}' expects a string literal value`,
    ).value;
    if (!this.isAtEnd() && !this.check(TokenType.NEWLINE) && !this.check(TokenType.SEMICOLON)) {
      const t = this.peek();
      const expected = key === "placeholder"
        ? "a parameter name and one string literal value"
        : "exactly one string literal value";
      throw new ParseError(
        `Metadata '@${key}' must contain ${expected}`,
        t.line,
        { start: t.start, end: t.end },
      );
    }
    return { kind: "Metadata", key, value, target, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseUsing(): Statement {
    const startTok = this.peek();
    this.expect(TokenType.KW_USING, "Expected 'using'");
    let relativeDots = 0;
    while (this.check(TokenType.DOT)) {
      this.advance();
      relativeDots++;
    }
    const path: string[] = [];
    path.push(this.expect(TokenType.IDENTIFIER, "Expected identifier in using path").value);
    let recursive = false;
    while (this.check(TokenType.DOT)) {
      this.advance();
      if (this.check(TokenType.STAR)) {
        this.advance();
        recursive = true;
        break;
      }
      path.push(this.expect(TokenType.IDENTIFIER, "Expected identifier in using path").value);
    }
    let alias: string | null = null;
    if (this.check(TokenType.KW_AS)) {
      if (recursive) {
        const t = this.peek();
        throw new ParseError("Recursive using import does not support an alias", t.line, { start: t.start, end: t.end });
      }
      this.advance();
      alias = this.expect(TokenType.IDENTIFIER, "Expected alias name after 'as'").value;
    }
    return { kind: "Using", relativeDots, path, recursive, alias, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseManifest(startTok: Token): Statement {
    this.expect(TokenType.KW_MANIFEST, "Expected 'manifest'");
    this.expect(TokenType.LBRACE, "Expected '{' after 'manifest'");
    this.skipNewlines();
    const entries = new Map<string, ManifestValue>();
    while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      const key = this.expect(TokenType.IDENTIFIER, "Expected key in manifest").value;
      this.expect(TokenType.EQ, "Expected '=' after key in manifest");
      entries.set(key, this.parseManifestValue());
      this.skipNewlines();
      if (this.check(TokenType.COMMA)) {
        this.advance();
        this.skipNewlines();
      }
    }
    this.expect(TokenType.RBRACE, "Expected '}' to close manifest");
    return { kind: "Manifest", entries, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseManifestValue(): ManifestValue {
    if (this.check(TokenType.STRING_LITERAL) || this.check(TokenType.INT_LITERAL) || this.check(TokenType.FLOAT_LITERAL)) {
      return { kind: "scalar", value: this.advance().value };
    }
    if (this.check(TokenType.LBRACKET)) {
      return this.parseManifestArrayValue();
    }
    const t = this.peek();
    throw new ParseError("Expected string, number, or array value in manifest", t.line, { start: t.start, end: t.end });
  }

  private parseManifestArrayValue(): ManifestValue {
    this.expect(TokenType.LBRACKET, "Expected '[' to start manifest array");
    this.skipNewlines();
    const values: string[] = [];
    while (!this.check(TokenType.RBRACKET) && !this.isAtEnd()) {
      if (this.check(TokenType.STRING_LITERAL) || this.check(TokenType.INT_LITERAL) || this.check(TokenType.FLOAT_LITERAL)) {
        values.push(this.advance().value);
      } else {
        const t = this.peek();
        throw new ParseError("Expected string or number value in manifest array", t.line, { start: t.start, end: t.end });
      }
      this.skipNewlines();
      if (this.check(TokenType.COMMA)) {
        this.advance();
        this.skipNewlines();
      } else {
        break;
      }
    }
    this.expect(TokenType.RBRACKET, "Expected ']' to close manifest array");
    return { kind: "list", values };
  }

  private parseDeclarationOrStatement(): Statement {
    const startTok = this.peek();
    const line = startTok.line;
    let access: AccessModifier | null = null;
    if (ACCESS_MODIFIERS.has(this.peekType())) {
      if (this.statementDepth > 0) {
        throw new ParseError("Access modifier can only be used on top-level declarations", line, { start: startTok.start, end: startTok.end });
      }
      access = this.parseAccessModifier();
    }

    switch (this.peekType()) {
      case TokenType.KW_MANIFEST: {
        if (this.statementDepth > 0) {
          throw new ParseError("Manifest can only be declared at file scope", line, { start: startTok.start, end: startTok.end });
        }
        if (access !== null) {
          throw new ParseError("Access modifier is not allowed on manifest declarations", line, { start: startTok.start, end: startTok.end });
        }
        return this.parseManifest(startTok);
      }
      case TokenType.KW_FUNCTION: return this.parseFunctionDecl(access ?? "private", startTok);
      case TokenType.KW_INTERVAL: return this.parseIntervalDecl(access ?? "private", startTok);
      case TokenType.KW_SCHEDULE: return this.parseScheduleDecl(access ?? "private", startTok);
      case TokenType.KW_ENUM: return this.parseEnumDecl(access ?? "private", startTok);
      case TokenType.KW_LISTENER: return this.parseListenerDecl(access ?? "private", startTok);
      case TokenType.KW_COMMAND: return this.parseCommandDecl(access ?? "private", startTok, true);
      case TokenType.KW_CONST: {
        this.advance();
        if (this.peekType() === TokenType.LPAREN) {
          return this.parseDeconstruction(access ?? "private", true, true, true, false, startTok);
        } else if (!this.isTypeKeyword(this.peekType())) {
          throw new ParseError("Const can only be used with variable declarations", line, { start: startTok.start, end: startTok.end });
        } else {
          return this.parseVarDecl(access ?? "private", true, startTok);
        }
      }
      default: {
        if (this.peekType() === TokenType.KW_VAR && this.peekType(1) === TokenType.LPAREN) {
          this.advance();
          return this.parseDeconstruction(access ?? "private", false, true, false, false, startTok);
        } else if (this.peekType() === TokenType.LPAREN && this.isDeconstructionAhead()) {
          const isDeclaration = this.isTypedDeconstructionPattern();
          if (access !== null && !isDeclaration) {
            throw new ParseError("Access modifier can only be used with declarations", line, { start: startTok.start, end: startTok.end });
          }
          return this.parseDeconstruction(access ?? "private", false, isDeclaration, isDeclaration, isDeclaration, startTok);
        } else if (access !== null && !this.isTypeKeyword(this.peekType())) {
          throw new ParseError("Access modifier can only be used with top-level declarations", line, { start: startTok.start, end: startTok.end });
        } else if (this.isTypeKeyword(this.peekType())) {
          return this.parseVarDecl(access ?? "private", false, startTok);
        } else {
          if (access !== null) {
            throw new ParseError("Access modifier can only be used with top-level declarations", line, { start: startTok.start, end: startTok.end });
          }
          switch (this.peekType()) {
            case TokenType.KW_IF: return this.parseIfStmt(startTok);
            case TokenType.KW_WHILE: return this.parseWhileStmt(startTok);
            case TokenType.KW_FOREACH: return this.parseForEachStmt(startTok);
            case TokenType.KW_TRY: return this.parseTryStmt(startTok);
            case TokenType.KW_RETURN: return this.parseReturnStmt(startTok);
            case TokenType.KW_BREAK:
              this.advance();
              return { kind: "BreakStmt", line, span: this.spanFrom(startTok) };
            case TokenType.KW_CONTINUE:
              this.advance();
              return { kind: "ContinueStmt", line, span: this.spanFrom(startTok) };
            default: {
              const expression = this.parseStatementExpression();
              return { kind: "ExprStatement", expression, line, span: this.spanFrom(startTok) };
            }
          }
        }
      }
    }
  }

  private parseAccessModifier(): AccessModifier {
    const token = this.advance();
    if (ACCESS_MODIFIERS.has(this.peekType())) {
      const t = this.peek();
      throw new ParseError("Only one access modifier is allowed", t.line, { start: t.start, end: t.end });
    }
    switch (token.type) {
      case TokenType.KW_PUBLIC: return "public";
      case TokenType.KW_PRIVATE: return "private";
      case TokenType.KW_PROTECTED: return "protected";
      default:
        throw new ParseError("Expected an access modifier", token.line, { start: token.start, end: token.end });
    }
  }

  private isTypeKeyword(type: TokenType): boolean {
    return TYPE_KEYWORDS.has(type);
  }

  private parseTypeRef(): TypeRef {
    const startTok = this.peek();
    let name: string;
    switch (this.peekType()) {
      case TokenType.KW_INT: this.advance(); name = "int"; break;
      case TokenType.KW_FLOAT: this.advance(); name = "float"; break;
      case TokenType.KW_STRING: this.advance(); name = "string"; break;
      case TokenType.KW_BOOL: this.advance(); name = "bool"; break;
      case TokenType.KW_OBJECT: this.advance(); name = "object"; break;
      case TokenType.KW_VAR: this.advance(); name = "var"; break;
      case TokenType.KW_LIST: {
        this.advance();
        this.expect(TokenType.LT, "Expected '<' after 'list'");
        const argRef = this.parseTypeRef();
        this.expect(TokenType.GT, "Expected '>' after list type argument");
        return { name: "list", typeArgRef: argRef, span: this.spanFrom(startTok) };
      }
      case TokenType.IDENTIFIER: name = this.advance().value; break;
      default: {
        const t = this.peek();
        throw new ParseError("Expected type", t.line, { start: t.start, end: t.end });
      }
    }
    return { name, typeArgRef: null, span: this.spanFrom(startTok) };
  }

  private parseVarDecl(access: AccessModifier, isConst: boolean, startTok: Token): Statement {
    const typeName = this.parseTypeRef();
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected variable name");
    this.expect(TokenType.EQ, "Expected '=' after variable name");
    const initializer = this.parseExpression();
    return {
      kind: "VarDecl",
      access,
      isConst,
      typeName,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      initializer,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseFunctionDecl(access: AccessModifier, startTok: Token): Statement {
    this.expect(TokenType.KW_FUNCTION, "Expected 'function'");
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected function name");
    this.expect(TokenType.LPAREN, "Expected '(' after function name");
    this.skipNewlines();
    const params = this.parseParams();
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after parameters");
    let returnType: TypeRef | null = null;
    if (this.check(TokenType.COLON)) {
      this.advance();
      returnType = this.parseTypeRef();
    }
    const body = this.parseBlock();
    return {
      kind: "FunctionDecl",
      access,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      params,
      returnType,
      body,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    this.skipNewlines();
    if (this.check(TokenType.RPAREN)) return params;
    params.push(this.parseParam());
    this.skipNewlines();
    while (this.check(TokenType.COMMA)) {
      this.advance();
      this.skipNewlines();
      params.push(this.parseParam());
      this.skipNewlines();
    }
    return params;
  }

  private parseParam(): Param {
    const startTok = this.peek();
    if (this.isTypeKeyword(this.peekType())) {
      const typeName = this.parseTypeRef();
      const nameTok = this.expect(TokenType.IDENTIFIER, "Expected parameter name");
      let def: Expression | null = null;
      if (this.check(TokenType.EQ)) {
        this.advance();
        def = this.parseExpression();
      }
      return {
        typeName,
        name: nameTok.value,
        nameSpan: { start: nameTok.start, end: nameTok.end },
        default: def,
        span: this.spanFrom(startTok),
      };
    }
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected parameter name");
    let def: Expression | null = null;
    if (this.check(TokenType.EQ)) {
      this.advance();
      def = this.parseExpression();
    }
    return {
      typeName: null,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      default: def,
      span: this.spanFrom(startTok),
    };
  }

  private parseCommandDecl(
    access: AccessModifier,
    startTok: Token,
    isRoot: boolean,
    providedAnnotations: CommandAnnotations | null = null,
  ): CommandDecl {
    const annotations = providedAnnotations
      ?? (isRoot ? this.pendingCommandAnnotations : EMPTY_COMMAND_ANNOTATIONS);
    if (isRoot && providedAnnotations === null) {
      this.pendingCommandAnnotations = EMPTY_COMMAND_ANNOTATIONS;
    }
    this.expect(TokenType.KW_COMMAND, "Expected 'command'");
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected command name");
    this.expect(TokenType.LPAREN, "Expected '(' after command name");
    this.skipNewlines();

    let senderName: string | null = null;
    let senderNameSpan: Span | null = null;
    const params: Param[] = [];

    if (!this.check(TokenType.RPAREN)) {
      if (isRoot && this.check(TokenType.KW_OBJECT)) {
        this.parseTypeRef();
        const senderTok = this.expect(TokenType.IDENTIFIER, "Expected sender parameter name");
        senderName = senderTok.value;
        senderNameSpan = { start: senderTok.start, end: senderTok.end };
        this.skipNewlines();
        if (this.check(TokenType.COMMA)) {
          this.advance();
          this.skipNewlines();
        }
      }
      while (!this.check(TokenType.RPAREN) && !this.isAtEnd()) {
        params.push(this.parseParam());
        this.skipNewlines();
        if (!this.check(TokenType.RPAREN)) {
          this.expect(TokenType.COMMA, "Expected ',' or ')' after parameter");
          this.skipNewlines();
        }
      }
    }
    this.expect(TokenType.RPAREN, "Expected ')' after parameters");
    this.skipNewlines();
    this.expect(TokenType.LBRACE, "Expected '{' to open command body");

    const bodyItems = this.withNestedStatements<CommandBodyItem[]>(() => {
      const items: CommandBodyItem[] = [];
      let defaultLine: number | null = null;
      const subCommandLines = new Map<string, number>();

      this.skipNewlines();
      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        if (this.check(TokenType.AT)) {
          const pendingMeta: Metadata[] = [];
          while (this.check(TokenType.AT)) {
            pendingMeta.push(this.parseMetadata());
            this.skipNewlines();
          }
          if (!this.check(TokenType.KW_COMMAND)) {
            for (const metadata of pendingMeta) {
              items.push({ kind: "code", stmt: metadata });
            }
          } else {
            const subStart = this.peek();
            const sub = this.parseCommandDecl(
              "private",
              subStart,
              false,
              this.buildCommandAnnotations(pendingMeta),
            );
            if (subCommandLines.has(sub.name)) {
              throw new ParseError(
                `Sub command '${sub.name}' is already declared in this command body`,
                sub.line,
                sub.span,
              );
            }
            subCommandLines.set(sub.name, sub.line);
            items.push({ kind: "subcommand", decl: sub });
          }
        } else if (this.check(TokenType.KW_COMMAND)) {
          const subStart = this.peek();
          const sub = this.parseCommandDecl("private", subStart, false);
          if (subCommandLines.has(sub.name)) {
            throw new ParseError(
              `Sub command '${sub.name}' is already declared in this command body`,
              sub.line,
              sub.span,
            );
          }
          subCommandLines.set(sub.name, sub.line);
          items.push({ kind: "subcommand", decl: sub });
        } else if (this.check(TokenType.KW_DEFAULT)) {
          const currentTok = this.peek();
          this.advance();
          if (defaultLine !== null) {
            throw new ParseError(
              "Default block is already declared in this command body",
              currentTok.line,
              { start: currentTok.start, end: currentTok.end },
            );
          }
          defaultLine = currentTok.line;
          items.push({ kind: "default", body: this.parseBlock() });
        } else {
          items.push({ kind: "code", stmt: this.parseDeclarationOrStatement() });
        }
        this.skipNewlines();
      }
      return items;
    });
    this.expect(TokenType.RBRACE, "Expected '}' to close command body");

    const hasSubOrDefault = bodyItems.some((it) => it.kind === "subcommand" || it.kind === "default");
    const finalItems: CommandBodyItem[] =
      !hasSubOrDefault && bodyItems.length > 0
        ? [{ kind: "default", body: bodyItems.map((it) => (it as { kind: "code"; stmt: Statement }).stmt) }]
        : bodyItems;

    this.validateCommandPlaceholders(params, annotations);
    return {
      kind: "CommandDecl",
      access,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      senderName,
      senderNameSpan,
      params,
      bodyItems: finalItems,
      annotations,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private validateCommandPlaceholders(params: Param[], annotations: CommandAnnotations): void {
    const paramNames = new Set(params.map((param) => param.name));
    for (const [name, placeholder] of annotations.placeholders) {
      if (!paramNames.has(name)) {
        throw new ParseError(
          `Placeholder references unknown command parameter '${name}'`,
          placeholder.line,
          placeholder.span,
        );
      }
      if (placeholder.value.trim().length === 0) {
        throw new ParseError(
          `Placeholder for command parameter '${name}' cannot be blank`,
          placeholder.line,
          placeholder.span,
        );
      }
    }
  }

  private parseIntervalDecl(access: AccessModifier, startTok: Token): Statement {
    this.expect(TokenType.KW_INTERVAL, "Expected 'interval'");
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected interval name");
    this.expect(TokenType.LPAREN, "Expected '(' after interval name");
    this.skipNewlines();
    const msToken = this.expect(TokenType.INT_LITERAL, "Interval period must be a positive integer literal");
    const ms = this.parseIntLiteral(msToken);
    if (ms === null || ms <= 0) {
      throw new ParseError("Interval period must be a positive integer literal", msToken.line, { start: msToken.start, end: msToken.end });
    }
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after interval ms");
    const body = this.parseBlock();
    return {
      kind: "IntervalDecl",
      access,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      intervalMs: ms,
      body,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseScheduleDecl(access: AccessModifier, startTok: Token): Statement {
    this.expect(TokenType.KW_SCHEDULE, "Expected 'schedule'");
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected schedule name");
    this.expect(TokenType.LPAREN, "Expected '(' after schedule name");
    this.skipNewlines();
    const cronTok = this.expect(TokenType.STRING_LITERAL, "Schedule cron must be a string literal");
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after schedule cron");
    const body = this.parseBlock();
    return {
      kind: "ScheduleDecl",
      access,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      cron: cronTok.value,
      body,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseEnumDecl(access: AccessModifier, startTok: Token): Statement {
    this.expect(TokenType.KW_ENUM, "Expected 'enum'");
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected enum name");
    this.expect(TokenType.LBRACE, "Expected '{' after enum name");
    this.skipNewlines();
    const entries = [];
    let nextImplicitValue: number | null = 0;

    while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      const entryStart = this.peek();
      const entryName = this.expect(TokenType.IDENTIFIER, "Expected enum entry name");
      let value: EnumValue;
      if (this.check(TokenType.EQ)) {
        this.advance();
        value = this.parseEnumValue();
        nextImplicitValue = value.kind === "int" ? value.value + 1 : null;
      } else {
        if (nextImplicitValue === null) {
          throw new ParseError(
            `Enum entry '${entryName.value}' needs an explicit value after a non-integer enum value`,
            entryName.line,
            { start: entryName.start, end: entryName.end },
          );
        }
        value = { kind: "int", value: nextImplicitValue };
        nextImplicitValue++;
      }
      entries.push({
        name: entryName.value,
        nameSpan: { start: entryName.start, end: entryName.end },
        value,
        line: entryName.line,
        span: this.spanFrom(entryStart),
      });
      this.skipNewlines();
      if (this.check(TokenType.COMMA)) {
        this.advance();
        this.skipNewlines();
      } else if (!this.check(TokenType.RBRACE)) {
        throw new ParseError("Expected ',' or '}' after enum entry", this.peek().line, {
          start: this.peek().start,
          end: this.peek().end,
        });
      }
    }

    this.expect(TokenType.RBRACE, "Expected '}' to close enum");
    if (entries.length === 0) {
      throw new ParseError(`Enum '${nameTok.value}' must declare at least one entry`, startTok.line, {
        start: startTok.start,
        end: startTok.end,
      });
    }
    return {
      kind: "EnumDecl",
      access,
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      entries,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseEnumValue(): EnumValue {
    const negative = this.check(TokenType.MINUS);
    if (negative) this.advance();
    const token = this.advance();
    switch (token.type) {
      case TokenType.INT_LITERAL: {
        const value = this.parseIntLiteral(token);
        if (value === null) {
          throw new ParseError(`Integer literal '${token.value}' is out of range`, token.line, {
            start: token.start,
            end: token.end,
          });
        }
        return { kind: "int", value: negative ? -value : value };
      }
      case TokenType.FLOAT_LITERAL:
        return { kind: "float", value: negative ? -Number(token.value) : Number(token.value) };
      case TokenType.STRING_LITERAL:
        if (negative) {
          throw new ParseError("Enum string value cannot be negative", token.line, { start: token.start, end: token.end });
        }
        return { kind: "string", value: token.value };
      case TokenType.BOOL_LITERAL:
        if (negative) {
          throw new ParseError("Enum bool value cannot be negative", token.line, { start: token.start, end: token.end });
        }
        return { kind: "bool", value: token.value === "true" };
      default:
        throw new ParseError("Enum value must be a string, number, or bool literal", token.line, {
          start: token.start,
          end: token.end,
        });
    }
  }

  private parseListenerDecl(access: AccessModifier, startTok: Token): Statement {
    const annotations = this.pendingListenerAnnotations;
    this.pendingListenerAnnotations = EMPTY_LISTENER_ANNOTATIONS;
    this.expect(TokenType.KW_LISTENER, "Expected 'listener'");
    const eventTok = this.expect(TokenType.IDENTIFIER, "Expected event type");
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected listener name");
    this.expect(TokenType.LPAREN, "Expected '(' after listener name");
    this.skipNewlines();
    let sender: string | null = null;
    let senderSpan: Span | null = null;
    if (!this.check(TokenType.RPAREN)) {
      this.expect(TokenType.KW_OBJECT, "Expected 'object' before sender parameter name");
      const senderTok = this.expect(TokenType.IDENTIFIER, "Expected sender parameter name");
      sender = senderTok.value;
      senderSpan = { start: senderTok.start, end: senderTok.end };
    }
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after sender parameter");
    const body = this.parseBlock();
    return {
      kind: "ListenerDecl",
      access,
      eventType: eventTok.value,
      eventTypeSpan: { start: eventTok.start, end: eventTok.end },
      name: nameTok.value,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      senderParam: sender,
      senderParamSpan: senderSpan,
      body,
      annotations,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseIfStmt(startTok: Token): Statement {
    this.expect(TokenType.KW_IF, "Expected 'if'");
    this.expect(TokenType.LPAREN, "Expected '(' after 'if'");
    this.skipNewlines();
    const condition = this.parseExpression();
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after condition");
    const thenBody = this.parseBlock();
    const elseIfClauses: { condition: Expression; body: Statement[] }[] = [];
    let elseBody: Statement[] | null = null;
    this.skipNewlines();
    while (this.check(TokenType.KW_ELSE)) {
      this.advance();
      this.skipNewlines();
      if (this.check(TokenType.KW_IF)) {
        this.advance();
        this.expect(TokenType.LPAREN, "Expected '(' after 'else if'");
        this.skipNewlines();
        const cond = this.parseExpression();
        this.skipNewlines();
        this.expect(TokenType.RPAREN, "Expected ')' after else-if condition");
        elseIfClauses.push({ condition: cond, body: this.parseBlock() });
        this.skipNewlines();
      } else {
        elseBody = this.parseBlock();
        break;
      }
    }
    return { kind: "IfStmt", condition, thenBody, elseIfClauses, elseBody, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseWhileStmt(startTok: Token): Statement {
    this.expect(TokenType.KW_WHILE, "Expected 'while'");
    this.expect(TokenType.LPAREN, "Expected '(' after 'while'");
    this.skipNewlines();
    const condition = this.parseExpression();
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after condition");
    const body = this.parseBlock();
    return { kind: "WhileStmt", condition, body, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseForEachStmt(startTok: Token): Statement {
    this.expect(TokenType.KW_FOREACH, "Expected 'foreach'");
    this.expect(TokenType.LPAREN, "Expected '(' after 'foreach'");
    this.skipNewlines();
    const itemType = this.parseOptionalForEachType();
    const itemTok = this.expect(TokenType.IDENTIFIER, "Expected item variable name");
    this.expect(TokenType.KW_IN, "Expected 'in' after item name");
    const iterable = this.parseExpression();
    this.skipNewlines();
    this.expect(TokenType.RPAREN, "Expected ')' after iterable");
    const body = this.parseBlock();
    return {
      kind: "ForEachStmt",
      itemType,
      itemName: itemTok.value,
      itemNameSpan: { start: itemTok.start, end: itemTok.end },
      iterable,
      body,
      line: startTok.line,
      span: this.spanFrom(startTok),
    };
  }

  private parseOptionalForEachType(): TypeRef | null {
    if (this.isTypeKeyword(this.peekType())) {
      return this.parseTypeRef();
    }
    if (this.peekType() === TokenType.IDENTIFIER && this.peekType(1) === TokenType.IDENTIFIER) {
      return this.parseTypeRef();
    }
    return null;
  }

  private parseReturnStmt(startTok: Token): Statement {
    this.expect(TokenType.KW_RETURN, "Expected 'return'");
    let value: Expression | null = null;
    if (!this.check(TokenType.NEWLINE) && !this.check(TokenType.SEMICOLON) && !this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      value = this.parseExpression();
    }
    return { kind: "ReturnStmt", value, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseTryStmt(startTok: Token): Statement {
    this.expect(TokenType.KW_TRY, "Expected 'try'");
    const tryBody = this.parseBlock();
    const catches: CatchClause[] = [];
    let finallyBody: Statement[] | null = null;
    let fallbackCatchLine: number | null = null;

    this.skipNewlines();
    while (this.check(TokenType.KW_CATCH)) {
      if (fallbackCatchLine !== null) {
        const t = this.peek();
        throw new ParseError("Catch after fallback catch is not allowed", t.line, { start: t.start, end: t.end });
      }
      const catchClause = this.parseCatchClause();
      if (catchClause.exceptionType === null) {
        fallbackCatchLine = catchClause.line;
      }
      catches.push(catchClause);
      this.skipNewlines();
    }

    if (this.check(TokenType.KW_FINALLY)) {
      this.advance();
      finallyBody = this.parseBlock();
      this.skipNewlines();
    }

    if (catches.length === 0 && finallyBody === null) {
      throw new ParseError("Try statement requires at least one catch or finally block", startTok.line, { start: startTok.start, end: startTok.end });
    }
    return { kind: "TryStmt", tryBody, catches, finallyBody, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseCatchClause(): CatchClause {
    const startTok = this.peek();
    this.expect(TokenType.KW_CATCH, "Expected 'catch'");
    let exceptionType: string | null = null;
    let variableName: string | null = null;
    let variableNameSpan: Span | null = null;

    if (this.check(TokenType.LPAREN)) {
      this.advance();
      exceptionType = this.expect(TokenType.IDENTIFIER, "Expected exception type in catch clause").value;
      if (this.check(TokenType.IDENTIFIER)) {
        const variableTok = this.advance();
        variableName = variableTok.value;
        variableNameSpan = { start: variableTok.start, end: variableTok.end };
      }
      this.expect(TokenType.RPAREN, "Expected ')' after catch clause");
    }

    const body = this.parseBlock();
    return { exceptionType, variableName, variableNameSpan, body, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseBlock(): Statement[] {
    this.skipNewlines();
    return this.withNestedStatements<Statement[]>(() => {
      if (!this.check(TokenType.LBRACE)) {
        return [this.parseDeclarationOrStatement()];
      }
      this.advance();
      const stmts: Statement[] = [];
      this.skipNewlines();
      while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
        const before = this.pos;
        try {
          stmts.push(this.parseDeclarationOrStatement());
        } catch (e) {
          if (!this.tolerant || !(e instanceof ParseError)) throw e;
          this.errors.push(e);
          this.synchronize(before, true);
        }
        this.skipNewlines();
      }
      this.expect(TokenType.RBRACE, "Expected '}' to close the block");
      return stmts;
    });
  }

  private parseExpression(): Expression {
    return this.parseTernary();
  }

  private parseStatementExpression(): Expression {
    const left = this.parseExpression();
    if (!ASSIGNMENT_OPERATORS.has(this.peekType())) return left;
    this.ensureAssignmentTarget(left);
    const opTok = this.peek();
    if (this.peekType() === TokenType.EQ) {
      this.advance();
      const value = this.parseExpression();
      return { kind: "Assign", target: left, value, line: opTok.line, span: { start: left.span.start, end: this.prev().end } };
    }
    if (
      this.peekType() === TokenType.PLUS_ASSIGN || this.peekType() === TokenType.MINUS_ASSIGN ||
      this.peekType() === TokenType.STAR_ASSIGN || this.peekType() === TokenType.SLASH_ASSIGN ||
      this.peekType() === TokenType.PERCENT_ASSIGN || this.peekType() === TokenType.STAR_STAR_ASSIGN
    ) {
      const op = this.advance();
      const value = this.parseExpression();
      return { kind: "CompoundAssign", target: left, operator: op, value, line: opTok.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private ensureAssignmentTarget(expr: Expression): void {
    if (expr.kind !== "Identifier" && expr.kind !== "MemberAccess" && expr.kind !== "IndexAccess") {
      throw new ParseError("Invalid assignment target", expr.line, expr.span);
    }
    if (this.isThreadResultTarget(expr)) {
      throw new ParseError("Cannot assign to a threaded result target", expr.line, expr.span);
    }
  }

  private isThreadResultTarget(expr: Expression): boolean {
    if (expr.kind === "MemberAccess") return this.startsWithThreadResult(expr.target);
    if (expr.kind === "IndexAccess") return this.startsWithThreadResult(expr.target);
    return false;
  }

  private startsWithThreadResult(expr: Expression): boolean {
    if (expr.kind === "ThreadCall" || expr.kind === "ThreadBlock") return true;
    if (expr.kind === "MemberAccess") return this.startsWithThreadResult(expr.target);
    if (expr.kind === "IndexAccess") return this.startsWithThreadResult(expr.target);
    return false;
  }

  private parseTernary(): Expression {
    const left = this.parseOr();
    if (this.check(TokenType.QUESTION)) {
      const opTok = this.peek();
      this.advance();
      const thenExpr = this.parseExpression();
      this.expect(TokenType.COLON, "Expected ':' in ternary expression");
      const elseExpr = this.parseExpression();
      return { kind: "Ternary", condition: left, thenExpr, elseExpr, line: opTok.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.check(TokenType.PIPE_PIPE)) {
      const op = this.advance();
      const right = this.parseAnd();
      left = { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseEquality();
    while (this.check(TokenType.AMP_AMP)) {
      const op = this.advance();
      const right = this.parseEquality();
      left = { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseEquality(): Expression {
    let left = this.parseComparison();
    while (EQUALITY_OPS.has(this.peekType())) {
      const op = this.advance();
      const right = this.parseComparison();
      left = { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseComparison(): Expression {
    let left = this.parseRange();
    while (COMPARISON_OPS.has(this.peekType()) || this.peekType() === TokenType.KW_IN) {
      const op = this.advance();
      const right = this.parseRange();
      left = { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseRange(): Expression {
    const left = this.parseAddSub();
    if (!this.isRangeOperator()) return left;
    const operator = this.advance();
    const right = this.parseAddSub();
    if (this.isRangeOperator()) {
      const t = this.peek();
      throw new ParseError("Range expressions cannot be chained", t.line, { start: t.start, end: t.end });
    }
    return {
      kind: "Range",
      start: left,
      end: right,
      inclusive: operator.type === TokenType.KW_TO,
      line: operator.line,
      span: { start: left.span.start, end: this.prev().end },
    };
  }

  private isRangeOperator(): boolean {
    return this.peekType() === TokenType.KW_TO || this.peekType() === TokenType.KW_UNTIL;
  }

  private parseAddSub(): Expression {
    let left = this.parseMulDiv();
    while (ADD_SUB_OPS.has(this.peekType())) {
      const op = this.advance();
      const right = this.parseMulDiv();
      left = { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseMulDiv(): Expression {
    let left = this.parsePower();
    while (MUL_DIV_OPS.has(this.peekType())) {
      const op = this.advance();
      const right = this.parsePower();
      left = { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parsePower(): Expression {
    const left = this.parseUnary();
    if (this.check(TokenType.STAR_STAR)) {
      const op = this.advance();
      const right = this.parsePower();
      return { kind: "BinaryOp", left, operator: op, right, line: op.line, span: { start: left.span.start, end: this.prev().end } };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (UNARY_OPS.has(this.peekType())) {
      const op = this.advance();
      const operand = this.parseUnary();
      return { kind: "UnaryOp", operator: op, operand, prefix: true, line: op.line, span: { start: op.start, end: this.prev().end } };
    }
    if (PREFIX_INC_DEC_OPS.has(this.peekType())) {
      const op = this.advance();
      const operand = this.parsePostfix();
      if (this.isThreadResultTarget(operand)) {
        throw new ParseError("Cannot mutate a threaded result target", op.line, { start: op.start, end: op.end });
      }
      return { kind: "UnaryOp", operator: op, operand, prefix: true, line: op.line, span: { start: op.start, end: this.prev().end } };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    let expr = this.parsePrimary();
    while (true) {
      if (this.check(TokenType.DOT)) {
        const opTok = this.peek();
        this.advance();
        const memberTok = this.expect(TokenType.IDENTIFIER, "Expected member name after '.'");
        if (this.check(TokenType.LPAREN)) {
          this.advance();
          const args = this.parseArgList();
          this.expect(TokenType.RPAREN, "Expected ')' after arguments");
          const member: Expression = {
            kind: "MemberAccess",
            target: expr,
            member: memberTok.value,
            memberSpan: { start: memberTok.start, end: memberTok.end },
            line: opTok.line,
            span: { start: expr.span.start, end: memberTok.end },
          };
          expr = { kind: "Call", callee: member, arguments: args, line: opTok.line, span: { start: expr.span.start, end: this.prev().end } };
        } else {
          expr = {
            kind: "MemberAccess",
            target: expr,
            member: memberTok.value,
            memberSpan: { start: memberTok.start, end: memberTok.end },
            line: opTok.line,
            span: { start: expr.span.start, end: this.prev().end },
          };
        }
      } else if (this.check(TokenType.LBRACKET)) {
        const opTok = this.peek();
        this.advance();
        const index = this.parseExpression();
        this.expect(TokenType.RBRACKET, "Expected ']' after index");
        expr = { kind: "IndexAccess", target: expr, index, line: opTok.line, span: { start: expr.span.start, end: this.prev().end } };
      } else if (this.check(TokenType.LPAREN) && this.canStartCall(expr)) {
        const opTok = this.peek();
        this.advance();
        this.skipNewlines();
        const args = this.parseArgList();
        this.skipNewlines();
        this.expect(TokenType.RPAREN, "Expected ')' after arguments");
        expr = { kind: "Call", callee: expr, arguments: args, line: opTok.line, span: { start: expr.span.start, end: this.prev().end } };
      } else if (this.check(TokenType.PLUS_PLUS) || this.check(TokenType.MINUS_MINUS)) {
        const op = this.advance();
        if (this.isThreadResultTarget(expr)) {
          throw new ParseError("Cannot mutate a threaded result target", op.line, { start: op.start, end: op.end });
        }
        expr = { kind: "UnaryOp", operator: op, operand: expr, prefix: false, line: op.line, span: { start: expr.span.start, end: op.end } };
      } else {
        break;
      }
    }
    return expr;
  }

  private canStartCall(expr: Expression): boolean {
    return (
      expr.kind === "Identifier" ||
      expr.kind === "Call" ||
      expr.kind === "MemberAccess" ||
      expr.kind === "IndexAccess" ||
      expr.kind === "ThreadCall"
    );
  }

  private parseArgList(): Expression[] {
    const args: Expression[] = [];
    this.skipNewlines();
    if (this.check(TokenType.RPAREN)) return args;
    args.push(this.parseExpression());
    this.skipNewlines();
    while (this.check(TokenType.COMMA)) {
      this.advance();
      this.skipNewlines();
      args.push(this.parseExpression());
      this.skipNewlines();
    }
    return args;
  }

  private parsePrimary(): Expression {
    if (this.peekType() === TokenType.KW_THREAD) {
      return this.parseThreadExpression();
    }
    return this.parseBasePrimary();
  }

  private parseBasePrimary(): Expression {
    const token = this.peek();
    const span: Span = { start: token.start, end: token.end };
    switch (token.type) {
      case TokenType.INT_LITERAL: {
        this.advance();
        const intValue = this.parseIntLiteral(token);
        if (intValue === null) {
          throw new ParseError(
            `Integer literal '${token.value}' is out of range (-2147483648..2147483647)`,
            token.line,
            span,
          );
        }
        return { kind: "IntLiteral", value: intValue, line: token.line, span };
      }
      case TokenType.FLOAT_LITERAL:
        this.advance();
        return { kind: "FloatLiteral", value: Number.parseFloat(token.value), line: token.line, span };
      case TokenType.STRING_LITERAL:
        this.advance();
        return { kind: "StringLiteral", value: token.value, line: token.line, span };
      case TokenType.INTERP_STRING:
        this.advance();
        return this.parseInterpolatedString(token);
      case TokenType.BOOL_LITERAL:
        this.advance();
        return { kind: "BoolLiteral", value: token.value === "true", line: token.line, span };
      case TokenType.KW_NULL:
        this.advance();
        return { kind: "NullLiteral", line: token.line, span };
      case TokenType.IDENTIFIER:
        this.advance();
        return { kind: "Identifier", name: token.value, line: token.line, span };
      case TokenType.LPAREN: {
        this.advance();
        this.skipNewlines();
        const expr = this.parseExpression();
        this.skipNewlines();
        this.expect(TokenType.RPAREN, "Expected ')'");
        return expr;
      }
      case TokenType.LBRACKET:
        return this.parseListLiteral(token);
      case TokenType.LBRACE:
        return this.parseObjectLiteral(token);
      default:
        throw new ParseError(`Unexpected token '${token.value}'`, token.line, span);
    }
  }

  private parseThreadExpression(): Expression {
    const threadToken = this.expect(TokenType.KW_THREAD, "Expected 'thread'");
    this.skipNewlines();
    if (this.check(TokenType.KW_THREAD)) {
      const t = this.peek();
      throw new ParseError("Directly nested 'thread' is not allowed", t.line, { start: t.start, end: t.end });
    }
    switch (this.peekType()) {
      case TokenType.KW_IF: {
        const stmt = this.parseIfStmt(this.peek());
        return { kind: "ThreadBlock", statement: stmt, line: threadToken.line, span: { start: threadToken.start, end: this.prev().end } };
      }
      case TokenType.KW_WHILE: {
        const stmt = this.parseWhileStmt(this.peek());
        return { kind: "ThreadBlock", statement: stmt, line: threadToken.line, span: { start: threadToken.start, end: this.prev().end } };
      }
      case TokenType.KW_FOREACH: {
        const stmt = this.parseForEachStmt(this.peek());
        return { kind: "ThreadBlock", statement: stmt, line: threadToken.line, span: { start: threadToken.start, end: this.prev().end } };
      }
      default: {
        const call = this.parseThreadCallTarget(threadToken);
        return { kind: "ThreadCall", call, line: threadToken.line, span: { start: threadToken.start, end: this.prev().end } };
      }
    }
  }

  private parseThreadCallTarget(threadToken: Token): Call {
    let expr: Expression = this.parseBasePrimary();
    while (true) {
      if (this.check(TokenType.DOT)) {
        const opTok = this.peek();
        this.advance();
        const memberTok = this.expect(TokenType.IDENTIFIER, "Expected member name after '.'");
        if (this.check(TokenType.LPAREN)) {
          this.advance();
          const args = this.parseArgList();
          this.expect(TokenType.RPAREN, "Expected ')' after arguments");
          const member: Expression = {
            kind: "MemberAccess",
            target: expr,
            member: memberTok.value,
            memberSpan: { start: memberTok.start, end: memberTok.end },
            line: opTok.line,
            span: { start: expr.span.start, end: memberTok.end },
          };
          return { kind: "Call", callee: member, arguments: args, line: opTok.line, span: { start: expr.span.start, end: this.prev().end } };
        }
        expr = {
          kind: "MemberAccess",
          target: expr,
          member: memberTok.value,
          memberSpan: { start: memberTok.start, end: memberTok.end },
          line: opTok.line,
          span: { start: expr.span.start, end: this.prev().end },
        };
      } else if (this.check(TokenType.LBRACKET)) {
        const opTok = this.peek();
        this.advance();
        const index = this.parseExpression();
        this.expect(TokenType.RBRACKET, "Expected ']' after index");
        expr = { kind: "IndexAccess", target: expr, index, line: opTok.line, span: { start: expr.span.start, end: this.prev().end } };
      } else if (this.check(TokenType.LPAREN) && this.canStartCall(expr)) {
        const opTok = this.peek();
        this.advance();
        this.skipNewlines();
        const args = this.parseArgList();
        this.skipNewlines();
        this.expect(TokenType.RPAREN, "Expected ')' after arguments");
        return { kind: "Call", callee: expr, arguments: args, line: opTok.line, span: { start: expr.span.start, end: this.prev().end } };
      } else {
        throw new ParseError("'thread' must target a block or a function/method call", threadToken.line, { start: threadToken.start, end: threadToken.end });
      }
    }
  }

  private parseInterpolatedString(token: Token): Expression {
    const raw = token.value;
    const parts: InterpolationPart[] = [];
    let i = 0;
    let literal = "";

    const flushLiteral = () => {
      if (literal.length > 0) {
        parts.push({ kind: "literal", text: literal });
        literal = "";
      }
    };

    while (i < raw.length) {
      if (raw[i] === "{" && i + 1 < raw.length && raw[i + 1] === "{") {
        literal += "{";
        i += 2;
      } else if (raw[i] === "}" && i + 1 < raw.length && raw[i + 1] === "}") {
        literal += "}";
        i += 2;
      } else if (raw[i] === "{") {
        flushLiteral();
        i++;
        let exprSrc = "";
        let braceDepth = 0;
        let parenDepth = 0;
        let bracketDepth = 0;
        let stringQuote: string | null = null;
        let escaped = false;

        while (i < raw.length) {
          const ch = raw[i];
          if (stringQuote !== null) {
            exprSrc += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === stringQuote) stringQuote = null;
          } else if (ch === '"' || ch === "'") {
            stringQuote = ch;
            exprSrc += ch;
          } else if (ch === "(") {
            parenDepth++;
            exprSrc += ch;
          } else if (ch === ")") {
            if (parenDepth > 0) parenDepth--;
            exprSrc += ch;
          } else if (ch === "[") {
            bracketDepth++;
            exprSrc += ch;
          } else if (ch === "]") {
            if (bracketDepth > 0) bracketDepth--;
            exprSrc += ch;
          } else if (ch === "{") {
            braceDepth++;
            exprSrc += ch;
          } else if (ch === "}") {
            if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
              break;
            }
            if (braceDepth > 0) braceDepth--;
            exprSrc += ch;
          } else {
            exprSrc += ch;
          }
          i++;
        }

        if (i >= raw.length || raw[i] !== "}") {
          throw new ParseError("Interpolation expression is not closed", token.line, { start: token.start, end: token.end });
        }

        const innerTokens = new Lexer(exprSrc).tokenize();
        const innerParser = new Parser(innerTokens);
        const innerExpr = innerParser.parseExpression();
        innerParser.skipNewlines();
        if (!innerParser.isAtEnd()) {
          throw new ParseError("Unexpected token in interpolation expression", token.line, { start: token.start, end: token.end });
        }
        parts.push({ kind: "expr", expression: innerExpr });
        i++;
      } else if (raw[i] === "}") {
        throw new ParseError(
          "Single '}' is not allowed in interpolated strings; use '}}' for a literal brace",
          token.line,
          { start: token.start, end: token.end },
        );
      } else {
        literal += raw[i];
        i++;
      }
    }
    flushLiteral();
    return { kind: "InterpolatedString", parts, line: token.line, span: { start: token.start, end: token.end } };
  }

  private parseListLiteral(startTok: Token): Expression {
    this.expect(TokenType.LBRACKET, "Expected '['");
    const elements: Expression[] = [];
    this.skipNewlines();
    while (!this.check(TokenType.RBRACKET) && !this.isAtEnd()) {
      elements.push(this.parseExpression());
      this.skipNewlines();
      if (!this.check(TokenType.RBRACKET)) {
        this.expect(TokenType.COMMA, "Expected ',' or ']' in list literal");
        this.skipNewlines();
      }
    }
    this.expect(TokenType.RBRACKET, "Expected ']' to close list literal");
    return { kind: "ListLiteral", elements, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseObjectLiteral(startTok: Token): Expression {
    this.expect(TokenType.LBRACE, "Expected '{'");
    const entries: ObjectEntry[] = [];
    this.skipNewlines();
    while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
      const keyTok = this.expect(TokenType.STRING_LITERAL, "Expected string key in object literal");
      this.expect(TokenType.COLON, "Expected ':' after object key");
      const value = this.parseExpression();
      entries.push({ key: keyTok.value, value, keySpan: { start: keyTok.start, end: keyTok.end } });
      this.skipNewlines();
      if (!this.check(TokenType.RBRACE)) {
        this.expect(TokenType.COMMA, "Expected ',' or '}' in object literal");
        this.skipNewlines();
      }
    }
    this.expect(TokenType.RBRACE, "Expected '}' to close object literal");
    return { kind: "ObjectLiteral", entries, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private isDeconstructionAhead(): boolean {
    if (this.peekType() !== TokenType.LPAREN) return false;
    let i = this.pos + 1;
    let depth = 0;
    while (i < this.tokens.length) {
      switch (this.tokens[i].type) {
        case TokenType.LPAREN:
          depth++;
          break;
        case TokenType.RPAREN:
          if (depth === 0) {
            i++;
            while (i < this.tokens.length && (this.tokens[i].type === TokenType.NEWLINE || this.tokens[i].type === TokenType.SEMICOLON)) i++;
            return i < this.tokens.length && this.tokens[i].type === TokenType.EQ;
          }
          depth--;
          break;
        case TokenType.EOF:
          return false;
        default:
          break;
      }
      i++;
    }
    return false;
  }

  private isTypedDeconstructionPattern(): boolean {
    if (this.peekType() !== TokenType.LPAREN) return false;
    let i = this.pos + 1;
    while (i < this.tokens.length && (this.tokens[i].type === TokenType.NEWLINE || this.tokens[i].type === TokenType.SEMICOLON)) i++;
    return i < this.tokens.length && this.isTypeKeyword(this.tokens[i].type);
  }

  private parseDeconstruction(
    access: AccessModifier,
    isConst: boolean,
    isDeclaration: boolean,
    allowTypes: boolean,
    requireTypes: boolean,
    startTok: Token,
  ): Statement {
    this.expect(TokenType.LPAREN, "Expected '('");
    this.skipNewlines();
    const bindings: DeconstructionBinding[] = [];
    while (!this.check(TokenType.RPAREN) && !this.isAtEnd()) {
      bindings.push(this.parseDeconstructionBinding(isDeclaration, allowTypes, requireTypes));
      this.skipNewlines();
      if (this.check(TokenType.COMMA)) {
        this.advance();
        this.skipNewlines();
      } else {
        break;
      }
    }
    this.expect(TokenType.RPAREN, "Expected ')' to close deconstruction pattern");
    this.expect(TokenType.EQ, "Expected '=' after deconstruction pattern");
    const initializer = this.parseExpression();
    return { kind: "Deconstruction", access, isConst, isDeclaration, bindings, initializer, line: startTok.line, span: this.spanFrom(startTok) };
  }

  private parseDeconstructionBinding(
    isDeclaration: boolean,
    allowTypes: boolean,
    requireTypes: boolean,
  ): DeconstructionBinding {
    const startTok = this.peek();
    if (this.check(TokenType.IDENTIFIER) && this.peek().value === "_") {
      this.advance();
      return { name: null, typeName: null, nameSpan: null, span: this.spanFrom(startTok) };
    }
    if (!allowTypes && this.isTypeKeyword(this.peekType())) {
      const t = this.peek();
      throw new ParseError("Deconstruction declared with 'var' cannot specify item types", t.line, { start: t.start, end: t.end });
    }
    if (requireTypes && !this.isTypeKeyword(this.peekType())) {
      const t = this.peek();
      throw new ParseError("Expected typed deconstruction item", t.line, { start: t.start, end: t.end });
    }
    let typeName: TypeRef | null = null;
    if (isDeclaration && allowTypes && this.isTypeKeyword(this.peekType())) {
      typeName = this.parseTypeRef();
    }
    const nameTok = this.expect(TokenType.IDENTIFIER, "Expected variable name or '_' in deconstruction pattern");
    return {
      name: nameTok.value,
      typeName,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      span: this.spanFrom(startTok),
    };
  }

  private parseIntLiteral(token: Token): number | null {
    if (!/^[0-9]+$/.test(token.value)) return null;
    const n = Number(token.value);
    if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) return null;
    return n;
  }
}
