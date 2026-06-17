import {
  CatchClause,
  CommandDecl,
  Expression,
  Statement,
} from "./ast";
import { isKnownEvent as defaultIsKnownEvent } from "./events";

export interface ResolverError {
  message: string;
  line: number;
  prevLine?: number;
}

const VALID_PRIORITIES = ["LOWEST", "LOW", "NORMAL", "HIGH", "HIGHEST", "MONITOR"];
const VALID_PRIORITY_SET: ReadonlySet<string> = new Set(VALID_PRIORITIES);
const COMMAND_DISALLOWED_PARAM_TYPES: ReadonlySet<string> = new Set(["list", "object", "var"]);

export class NameResolver {
  private readonly errors: ResolverError[] = [];
  private readonly scopes: Map<string, number>[] = [];
  private manifestLine: number | null = null;
  private insideFunction = false;
  private insideLoop = false;
  private isFileScope = true;

  constructor(
    private readonly reservedNames: ReadonlySet<string> = new Set(),
    private readonly isKnownEvent: (name: string) => boolean = defaultIsKnownEvent,
  ) {}

  resolve(stmts: Statement[], predefinedNames: ReadonlySet<string> = new Set()): ResolverError[] {
    this.errors.length = 0;
    this.pushScope();
    for (const name of predefinedNames) {
      this.currentScope().set(name, 0);
    }
    this.hoistScopeDeclarations(stmts);
    for (const stmt of stmts) this.resolveStmt(stmt);
    this.popScope();
    return [...this.errors];
  }

  private resolveStmt(stmt: Statement): void {
    switch (stmt.kind) {
      case "Metadata":
      case "Using":
        return;

      case "Manifest": {
        if (!this.isFileScope) this.error("Manifest can only be declared at file scope", stmt.line);
        if (this.manifestLine !== null) {
          this.errors.push({ message: "Manifest is already declared", line: stmt.line, prevLine: this.manifestLine });
        } else {
          this.manifestLine = stmt.line;
        }
        return;
      }

      case "VarDecl": {
        this.resolveExpr(stmt.initializer);
        this.declare(stmt.name, stmt.line);
        return;
      }

      case "ExprStatement": {
        this.resolveExpr(stmt.expression);
        return;
      }

      case "FunctionDecl": {
        if (!this.isFileScope) this.error("Function can only be declared at file scope", stmt.line);
        for (const param of stmt.params) {
          if (param.typeName === null) {
            this.error(`Parameter '${param.name}' must have a type annotation`, stmt.line);
          }
        }
        this.withDeclarationContext(true, false, false, () => {
          this.pushScope();
          for (const param of stmt.params) this.declare(param.name, stmt.line);
          for (const bodyStmt of stmt.body) this.resolveStmt(bodyStmt);
          this.popScope();
        });
        return;
      }

      case "IntervalDecl": {
        if (!this.isFileScope) this.error("Interval can only be declared at file scope", stmt.line);
        this.withDeclarationContext(true, false, false, () => {
          this.pushScope();
          for (const bodyStmt of stmt.body) this.resolveStmt(bodyStmt);
          this.popScope();
        });
        return;
      }

      case "ScheduleDecl": {
        if (!this.isFileScope) this.error("Schedule can only be declared at file scope", stmt.line);
        this.withDeclarationContext(true, false, false, () => {
          this.pushScope();
          for (const bodyStmt of stmt.body) this.resolveStmt(bodyStmt);
          this.popScope();
        });
        return;
      }

      case "EnumDecl": {
        if (!this.isFileScope) this.error("Enum can only be declared at file scope", stmt.line);
        const seen = new Map<string, number>();
        for (const entry of stmt.entries) {
          const prev = seen.get(entry.name);
          if (prev !== undefined) {
            this.errors.push({ message: `Enum entry '${entry.name}' is already declared`, line: entry.line, prevLine: prev });
          } else {
            seen.set(entry.name, entry.line);
          }
        }
        return;
      }

      case "ListenerDecl": {
        if (!this.isFileScope) this.error("Listener can only be declared at file scope", stmt.line);
        if (!this.isKnownEvent(stmt.eventType)) {
          this.error(`Unknown event type '${stmt.eventType}'`, stmt.line);
        }
        const priority = stmt.annotations.priority;
        if (priority !== null && !VALID_PRIORITY_SET.has(priority.toUpperCase())) {
          this.error(
            `Unknown event priority '${priority}'. Valid values: ${VALID_PRIORITIES.join(", ")}`,
            stmt.line,
          );
        }
        this.withDeclarationContext(true, false, false, () => {
          this.pushScope();
          if (stmt.senderParam !== null) this.declare(stmt.senderParam, stmt.line);
          for (const bodyStmt of stmt.body) this.resolveStmt(bodyStmt);
          this.popScope();
        });
        return;
      }

      case "IfStmt": {
        this.resolveExpr(stmt.condition);
        const prevFile = this.isFileScope;
        this.isFileScope = false;
        this.resolveBlock(stmt.thenBody);
        for (const clause of stmt.elseIfClauses) {
          this.resolveExpr(clause.condition);
          this.resolveBlock(clause.body);
        }
        if (stmt.elseBody !== null) this.resolveBlock(stmt.elseBody);
        this.isFileScope = prevFile;
        return;
      }

      case "WhileStmt": {
        this.resolveExpr(stmt.condition);
        const prevLoop = this.insideLoop;
        const prevFile = this.isFileScope;
        this.insideLoop = true;
        this.isFileScope = false;
        this.resolveBlock(stmt.body);
        this.insideLoop = prevLoop;
        this.isFileScope = prevFile;
        return;
      }

      case "ForEachStmt": {
        this.resolveExpr(stmt.iterable);
        const prevLoop = this.insideLoop;
        const prevFile = this.isFileScope;
        this.insideLoop = true;
        this.isFileScope = false;
        this.pushScope();
        this.declare(stmt.itemName, stmt.line);
        for (const bodyStmt of stmt.body) this.resolveStmt(bodyStmt);
        this.popScope();
        this.insideLoop = prevLoop;
        this.isFileScope = prevFile;
        return;
      }

      case "TryStmt": {
        const prevFile = this.isFileScope;
        this.isFileScope = false;
        this.resolveBlock(stmt.tryBody);
        for (const catchClause of stmt.catches) this.resolveCatchClause(catchClause);
        if (stmt.finallyBody !== null) this.resolveBlock(stmt.finallyBody);
        this.isFileScope = prevFile;
        return;
      }

      case "ReturnStmt": {
        if (!this.insideFunction) this.error("Return cannot be used outside of a function", stmt.line);
        if (stmt.value !== null) this.resolveExpr(stmt.value);
        return;
      }

      case "BreakStmt": {
        if (!this.insideLoop) this.error("Break can only be used inside a loop", stmt.line);
        return;
      }

      case "ContinueStmt": {
        if (!this.insideLoop) this.error("Continue can only be used inside a loop", stmt.line);
        return;
      }

      case "CommandDecl": {
        if (!this.isFileScope) this.error("Command can only be declared at file scope", stmt.line);
        this.withDeclarationContext(true, false, false, () => {
          this.resolveCommandDecl(stmt, stmt.senderName);
        });
        return;
      }

      case "Deconstruction": {
        this.resolveExpr(stmt.initializer);
        for (const binding of stmt.bindings) {
          const name = binding.name;
          if (name === null) continue;
          if (stmt.isDeclaration) {
            this.declare(name, stmt.line);
          } else if (!this.isDeclared(name)) {
            this.error(`Undefined identifier '${name}'`, stmt.line);
          }
        }
        return;
      }
    }
  }

  private withDeclarationContext(
    insideFunction: boolean,
    insideLoop: boolean,
    isFileScope: boolean,
    block: () => void,
  ): void {
    const prevFn = this.insideFunction;
    const prevLoop = this.insideLoop;
    const prevFile = this.isFileScope;
    this.insideFunction = insideFunction;
    this.insideLoop = insideLoop;
    this.isFileScope = isFileScope;
    try {
      block();
    } finally {
      this.insideFunction = prevFn;
      this.insideLoop = prevLoop;
      this.isFileScope = prevFile;
    }
  }

  private withThreadBoundary(block: () => void): void {
    const prevFn = this.insideFunction;
    const prevLoop = this.insideLoop;
    const prevFile = this.isFileScope;
    this.insideFunction = false;
    this.insideLoop = false;
    this.isFileScope = false;
    try {
      block();
    } finally {
      this.insideFunction = prevFn;
      this.insideLoop = prevLoop;
      this.isFileScope = prevFile;
    }
  }

  private resolveCatchClause(catchClause: CatchClause): void {
    this.pushScope();
    if (catchClause.variableName !== null) this.declare(catchClause.variableName, catchClause.line);
    for (const bodyStmt of catchClause.body) this.resolveStmt(bodyStmt);
    this.popScope();
  }

  private resolveCommandDecl(stmt: CommandDecl, inheritedSenderName: string | null): void {
    for (const param of stmt.params) {
      if (param.typeName === null) {
        this.error(`Parameter '${param.name}' must have a type annotation`, stmt.line);
      } else if (COMMAND_DISALLOWED_PARAM_TYPES.has(param.typeName.name)) {
        this.error(`Command parameter '${param.name}' cannot use type '${param.typeName.name}'`, stmt.line);
      }
    }
    const effectiveSenderName = stmt.senderName ?? inheritedSenderName;
    this.pushScope();
    if (effectiveSenderName !== null) this.declare(effectiveSenderName, stmt.line);
    for (const param of stmt.params) {
      if (param.default !== null) this.resolveExpr(param.default);
      this.declare(param.name, stmt.line);
    }
    for (const item of stmt.bodyItems) {
      switch (item.kind) {
        case "code":
          this.resolveStmt(item.stmt);
          break;
        case "subcommand":
          this.resolveCommandDecl(item.decl, effectiveSenderName);
          break;
        case "default":
          for (const bodyStmt of item.body) this.resolveStmt(bodyStmt);
          break;
      }
    }
    this.popScope();
  }

  private resolveBlock(stmts: Statement[]): void {
    this.pushScope();
    for (const stmt of stmts) this.resolveStmt(stmt);
    this.popScope();
  }

  private resolveExpr(expr: Expression): void {
    switch (expr.kind) {
      case "BinaryOp":
        this.resolveExpr(expr.left);
        this.resolveExpr(expr.right);
        return;
      case "UnaryOp":
        this.resolveExpr(expr.operand);
        return;
      case "Ternary":
        this.resolveExpr(expr.condition);
        this.resolveExpr(expr.thenExpr);
        this.resolveExpr(expr.elseExpr);
        return;
      case "Range":
        this.resolveExpr(expr.start);
        this.resolveExpr(expr.end);
        return;
      case "Call":
        this.resolveExpr(expr.callee);
        for (const arg of expr.arguments) this.resolveExpr(arg);
        return;
      case "ThreadCall":
        this.resolveExpr(expr.call.callee);
        for (const arg of expr.call.arguments) this.resolveExpr(arg);
        return;
      case "ThreadBlock":
        this.withThreadBoundary(() => this.resolveStmt(expr.statement));
        return;
      case "MemberAccess":
        this.resolveExpr(expr.target);
        return;
      case "IndexAccess":
        this.resolveExpr(expr.target);
        this.resolveExpr(expr.index);
        return;
      case "Assign":
        this.resolveExpr(expr.target);
        this.resolveExpr(expr.value);
        return;
      case "CompoundAssign":
        this.resolveExpr(expr.target);
        this.resolveExpr(expr.value);
        return;
      case "ListLiteral":
        for (const element of expr.elements) this.resolveExpr(element);
        return;
      case "ObjectLiteral":
        for (const entry of expr.entries) this.resolveExpr(entry.value);
        return;
      case "InterpolatedString":
        for (const part of expr.parts) {
          if (part.kind === "expr") this.resolveExpr(part.expression);
        }
        return;
      case "IntLiteral":
      case "FloatLiteral":
      case "StringLiteral":
      case "BoolLiteral":
      case "NullLiteral":
        return;
      case "Identifier": {
        const defined = this.scopes.some((scope) => scope.has(expr.name)) || this.reservedNames.has(expr.name);
        if (!defined) this.error(`Undefined identifier '${expr.name}'`, expr.line);
        return;
      }
    }
  }

  private currentScope(): Map<string, number> {
    return this.scopes[this.scopes.length - 1];
  }

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private hoistScopeDeclarations(stmts: Statement[]): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "FunctionDecl":
        case "IntervalDecl":
        case "ScheduleDecl":
        case "ListenerDecl":
        case "CommandDecl":
        case "EnumDecl":
          this.declare(stmt.name, stmt.line);
          break;
        default:
          break;
      }
    }
  }

  private declare(name: string, line: number): void {
    const current = this.currentScope();
    const prev = current.get(name);
    if (prev !== undefined) {
      this.errors.push({ message: `'${name}' is already declared`, line, prevLine: prev });
      return;
    }
    if (this.reservedNames.has(name)) {
      this.errors.push({ message: `'${name}' is a built-in name and cannot be redeclared`, line });
      return;
    }
    current.set(name, line);
  }

  private isDeclared(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  private error(message: string, line: number): void {
    this.errors.push({ message, line });
  }
}
