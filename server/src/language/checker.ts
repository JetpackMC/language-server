import {
  CatchClause,
  CommandDecl,
  EnumDecl,
  EnumValue,
  Expression,
  Statement,
  TypeRef,
} from "./ast";
import { TokenType } from "./token";
import {
  CallSignature,
  JetType,
  TBool,
  TCallable,
  TCommand,
  TFloat,
  TFunction,
  TInt,
  TInterval,
  TList,
  TListener,
  TModule,
  TNull,
  TObject,
  TSchedule,
  TString,
  TUnknown,
  accepts,
  asNullable,
  isNumeric,
  paramsToCallSignature,
  signatureDescribe,
  signatureMatchScore,
  typeEquals,
  typeRefToJetType,
  typeRefToJetTypeOrNull,
  typeToString,
  withoutNull,
} from "./types";
import { BuiltinTypeProvider } from "./builtins";

export interface TypeCheckerError {
  message: string;
  line: number;
}

const EXCEPTION_SUPERTYPES: ReadonlySet<string> = new Set([
  "Exception",
  "RuntimeException",
  "TypeException",
  "NameException",
  "IndexException",
  "KeyException",
  "ArgumentException",
  "ArithmeticException",
  "StateException",
  "PermissionException",
  "NativeException",
  "ModuleException",
]);

enum FlowSignal {
  FALLTHROUGH = "FALLTHROUGH",
  RETURN = "RETURN",
  BREAK = "BREAK",
  CONTINUE = "CONTINUE",
  NON_TERMINATING = "NON_TERMINATING",
}

interface NullConditionNarrowing {
  whenTrue: Map<string, JetType>;
  whenFalse: Map<string, JetType>;
}

interface ConstantValue {
  kind: "int";
  value: number;
}

const COMPARISON_OPS: ReadonlySet<TokenType> = new Set([
  TokenType.LT,
  TokenType.LT_EQ,
  TokenType.GT,
  TokenType.GT_EQ,
]);

export class TypeChecker {
  private readonly errors: TypeCheckerError[] = [];
  private readonly typeScopes: Map<string, JetType>[] = [];
  private readonly constScopes: Set<string>[] = [];
  private readonly readOnlyScopes: Set<string>[] = [];
  private readonly constValueScopes: Map<string, ConstantValue>[] = [];
  private currentReturnType: JetType | null = null;

  constructor(private readonly typeProvider: BuiltinTypeProvider | null = null) {}

  check(stmts: Statement[], predefinedTypes: ReadonlyMap<string, JetType> = new Map()): TypeCheckerError[] {
    this.errors.length = 0;
    this.pushScope();
    for (const [name, type] of predefinedTypes) {
      this.defineType(name, type, true);
    }
    for (const stmt of stmts) {
      if (stmt.kind === "FunctionDecl") this.hoistFunction(stmt);
      if (stmt.kind === "IntervalDecl") this.defineType(stmt.name, TInterval);
      if (stmt.kind === "ScheduleDecl") this.defineType(stmt.name, TSchedule);
      if (stmt.kind === "ListenerDecl") this.defineType(stmt.name, TListener);
      if (stmt.kind === "CommandDecl") this.defineType(stmt.name, TCommand);
      if (stmt.kind === "EnumDecl") this.defineType(stmt.name, this.enumType(stmt), true);
    }
    for (const stmt of stmts) this.checkStmt(stmt);
    this.popScope();
    return [...this.errors];
  }

  private checkStmt(stmt: Statement): void {
    switch (stmt.kind) {
      case "Metadata":
      case "Using":
      case "Manifest":
        return;

      case "VarDecl": {
        const declaredType = this.resolveTypeRef(stmt.typeName, stmt.line, `Variable '${stmt.name}'`);
        const initType = this.inferExpr(stmt.initializer);
        let actualType: JetType;
        if (declaredType.kind === "unknown") {
          actualType = initType.kind === "null" ? asNullable(TUnknown) : initType;
        } else if (initType.kind === "null") {
          actualType = asNullable(declaredType);
        } else {
          if (!accepts(declaredType, initType)) {
            this.report(`Expected type '${typeToString(declaredType)}' but got '${typeToString(initType)}'`, stmt.line);
          }
          actualType = declaredType;
        }
        this.defineType(
          stmt.name,
          actualType,
          stmt.isConst,
          stmt.isConst ? this.evaluateConstantValue(stmt.initializer) : null,
        );
        return;
      }

      case "ExprStatement": {
        this.inferExpr(stmt.expression);
        return;
      }

      case "FunctionDecl": {
        const retType = stmt.returnType
          ? this.resolveTypeRef(stmt.returnType, stmt.line, `Function '${stmt.name}' return type`)
          : TUnknown;
        const paramTypes = new Map(
          stmt.params.map((param) => [
            param,
            param.typeName ? this.resolveTypeRef(param.typeName, stmt.line, `Parameter '${param.name}'`) : TUnknown,
          ] as const),
        );
        const prevReturn = this.currentReturnType;
        this.currentReturnType = retType;
        for (const param of stmt.params) {
          if (param.default !== null) {
            const paramType = paramTypes.get(param)!;
            const defaultType = this.inferExpr(param.default);
            if (paramType.kind !== "unknown" && !accepts(paramType, defaultType)) {
              this.report(
                `Default value for parameter '${param.name}' has type '${typeToString(defaultType)}', expected '${typeToString(paramType)}'`,
                stmt.line,
              );
            }
          }
        }
        this.pushScope();
        for (const param of stmt.params) {
          this.defineType(param.name, paramTypes.get(param)!);
        }
        for (const bodyStmt of stmt.body) this.checkStmt(bodyStmt);
        if (retType.kind !== "unknown" && !this.hasRequiredReturns(stmt.body)) {
          this.report(
            `Function '${stmt.name}' with return type '${typeToString(retType)}' does not always return a value`,
            stmt.line,
          );
        }
        this.popScope();
        this.currentReturnType = prevReturn;
        return;
      }

      case "IntervalDecl": {
        this.pushScope();
        for (const bodyStmt of stmt.body) this.checkStmt(bodyStmt);
        this.popScope();
        return;
      }

      case "ScheduleDecl": {
        this.pushScope();
        for (const bodyStmt of stmt.body) this.checkStmt(bodyStmt);
        this.popScope();
        return;
      }

      case "EnumDecl":
        return;

      case "ListenerDecl": {
        this.pushScope();
        if (stmt.senderParam !== null) this.defineType(stmt.senderParam, TObject);
        for (const bodyStmt of stmt.body) this.checkStmt(bodyStmt);
        this.popScope();
        return;
      }

      case "IfStmt": {
        this.checkCondition(stmt.condition);
        const narrowing = this.extractNullConditionNarrowing(stmt.condition);
        this.checkBlock(stmt.thenBody, narrowing?.whenTrue);
        for (const clause of stmt.elseIfClauses) {
          this.checkCondition(clause.condition);
          this.checkBlock(clause.body, this.extractNullConditionNarrowing(clause.condition)?.whenTrue);
        }
        if (stmt.elseBody !== null) this.checkBlock(stmt.elseBody, narrowing?.whenFalse);

        if (narrowing !== null) {
          const thenFallsThrough = this.analyzeBlockFlow(stmt.thenBody).has(FlowSignal.FALLTHROUGH);
          const elseFallsThrough =
            stmt.elseBody !== null ? this.analyzeBlockFlow(stmt.elseBody).has(FlowSignal.FALLTHROUGH) : null;
          if (!thenFallsThrough) {
            this.applyTypeOverrides(narrowing.whenFalse);
          } else if (stmt.elseIfClauses.length === 0 && elseFallsThrough === false) {
            this.applyTypeOverrides(narrowing.whenTrue);
          }
        }
        return;
      }

      case "WhileStmt": {
        this.checkCondition(stmt.condition);
        this.checkBlock(stmt.body, this.extractNullConditionNarrowing(stmt.condition)?.whenTrue);
        return;
      }

      case "ForEachStmt": {
        const iterableType = this.inferExpr(stmt.iterable);
        let elementType: JetType;
        switch (iterableType.kind) {
          case "list": elementType = iterableType.elementType; break;
          case "string": elementType = TString; break;
          case "object": elementType = TObject; break;
          case "unknown": elementType = TUnknown; break;
          default:
            this.report(`Cannot iterate over value of type '${typeToString(iterableType)}'`, stmt.line);
            elementType = TUnknown;
        }
        const declaredElementType = stmt.itemType
          ? this.resolveTypeRef(stmt.itemType, stmt.line, `Foreach item '${stmt.itemName}'`)
          : null;
        if (
          declaredElementType !== null &&
          declaredElementType.kind !== "unknown" &&
          !accepts(declaredElementType, elementType)
        ) {
          this.report(
            `Foreach item '${stmt.itemName}' has type '${typeToString(declaredElementType)}' but iterable yields '${typeToString(elementType)}'`,
            stmt.line,
          );
        }
        this.pushScope();
        this.defineReadOnly(stmt.itemName, declaredElementType ?? elementType);
        for (const bodyStmt of stmt.body) this.checkStmt(bodyStmt);
        this.popScope();
        return;
      }

      case "TryStmt": {
        this.checkBlock(stmt.tryBody);
        for (const catchClause of stmt.catches) this.checkCatchClause(catchClause);
        if (stmt.finallyBody !== null) this.checkBlock(stmt.finallyBody);
        return;
      }

      case "ReturnStmt": {
        const expected = this.currentReturnType;
        if (expected !== null && expected.kind !== "unknown") {
          if (stmt.value === null) {
            this.report(`Missing return value for function returning '${typeToString(expected)}'`, stmt.line);
          } else {
            const actual = this.inferExpr(stmt.value);
            if (!accepts(expected, actual)) {
              this.report("Return type does not match function return type", stmt.line);
            }
          }
        } else if (stmt.value !== null) {
          this.inferExpr(stmt.value);
        }
        return;
      }

      case "BreakStmt":
      case "ContinueStmt":
        return;

      case "Deconstruction": {
        const positionalTypes =
          stmt.initializer.kind === "ListLiteral"
            ? stmt.initializer.elements.map((e) => this.inferExpr(e))
            : null;
        const initType = positionalTypes
          ? TList(positionalTypes.length === 0 ? TUnknown : this.commonSupertype(positionalTypes))
          : this.inferExpr(stmt.initializer);
        if (initType.kind !== "list" && initType.kind !== "unknown") {
          this.report(`Deconstruction requires a list, got '${typeToString(initType)}'`, stmt.line);
        }
        const elementType = initType.kind === "list" ? initType.elementType : TUnknown;
        stmt.bindings.forEach((binding, index) => {
          const name = binding.name;
          if (name === null) return;
          const bindingElementType = positionalTypes?.[index] ?? elementType;
          if (positionalTypes !== null && index >= positionalTypes.length) {
            this.report(`Deconstruction index ${index} is out of range`, stmt.line);
          }
          const declaredType = binding.typeName
            ? this.resolveTypeRef(binding.typeName, stmt.line, `Deconstruction variable '${name}'`)
            : null;
          if (
            declaredType !== null &&
            declaredType.kind !== "unknown" &&
            bindingElementType.kind !== "unknown" &&
            !accepts(declaredType, bindingElementType)
          ) {
            this.report(
              `Deconstruction variable '${name}' has type '${typeToString(declaredType)}' but list yields '${typeToString(bindingElementType)}'`,
              stmt.line,
            );
          }
          if (stmt.isDeclaration) {
            this.defineType(name, declaredType ?? bindingElementType, stmt.isConst);
          } else {
            const targetType = this.lookupType(name) ?? TUnknown;
            if (this.isConst(name)) {
              this.report(`Cannot reassign const variable '${name}'`, stmt.line);
            } else if (this.isReadOnly(name)) {
              this.report(`Cannot reassign foreach item '${name}'`, stmt.line);
            } else if (
              targetType.kind !== "unknown" &&
              bindingElementType.kind !== "unknown" &&
              !accepts(targetType, bindingElementType)
            ) {
              this.report(
                `Cannot assign list element of type '${typeToString(bindingElementType)}' to variable '${name}' of type '${typeToString(targetType)}'`,
                stmt.line,
              );
            }
          }
        });
        return;
      }

      case "CommandDecl": {
        this.checkCommandDecl(stmt, stmt.senderName);
        return;
      }
    }
  }

  private checkCatchClause(catchClause: CatchClause): void {
    const exceptionType = catchClause.exceptionType;
    if (exceptionType !== null && !EXCEPTION_SUPERTYPES.has(exceptionType)) {
      this.report(`Unknown exception type '${exceptionType}'`, catchClause.line);
    }
    this.pushScope();
    if (catchClause.variableName !== null) this.defineReadOnly(catchClause.variableName, TObject);
    for (const bodyStmt of catchClause.body) this.checkStmt(bodyStmt);
    this.popScope();
  }

  private checkCommandDecl(stmt: CommandDecl, inheritedSenderName: string | null): void {
    const effectiveSenderName = stmt.senderName ?? inheritedSenderName;
    this.pushScope();
    if (effectiveSenderName !== null) this.currentTypeScope().set(effectiveSenderName, TObject);
    const paramTypes = new Map(
      stmt.params.map((param) => [
        param,
        param.typeName ? this.resolveTypeRef(param.typeName, stmt.line, `Command parameter '${param.name}'`) : TUnknown,
      ] as const),
    );
    for (const param of stmt.params) {
      if (param.default !== null) {
        if (!this.isConstantExpression(param.default)) {
          this.report(
            `Default value for command parameter '${param.name}' must be a constant expression`,
            stmt.line,
          );
        }
        const paramType = paramTypes.get(param)!;
        const defaultType = this.inferExpr(param.default);
        if (paramType.kind !== "unknown" && !accepts(paramType, defaultType)) {
          this.report(
            `Default value for parameter '${param.name}' has type '${typeToString(defaultType)}', expected '${typeToString(paramType)}'`,
            stmt.line,
          );
        }
      }
      this.currentTypeScope().set(param.name, paramTypes.get(param)!);
    }
    const prevReturn = this.currentReturnType;
    this.currentReturnType = null;
    for (const item of stmt.bodyItems) {
      switch (item.kind) {
        case "code":
          this.checkStmt(item.stmt);
          break;
        case "subcommand":
          this.checkCommandDecl(item.decl, effectiveSenderName);
          break;
        case "default":
          for (const bodyStmt of item.body) this.checkStmt(bodyStmt);
          break;
      }
    }
    this.currentReturnType = prevReturn;
    this.popScope();
  }

  private checkBlock(stmts: Statement[], predefinedTypes?: Map<string, JetType>): void {
    this.pushScope();
    if (predefinedTypes) {
      for (const [name, type] of predefinedTypes) this.defineType(name, type);
    }
    for (const stmt of stmts) this.checkStmt(stmt);
    this.popScope();
  }

  private checkCondition(expr: Expression): void {
    const type = this.inferExpr(expr);
    if (type.kind === "null") this.report("Condition cannot be null", expr.line);
  }

  private isNullableType(type: JetType): boolean {
    return type.kind === "null" || type.kind === "nullable";
  }

  private commonSupertype(types: JetType[]): JetType {
    const nonUnknown = types.filter((t) => t.kind !== "unknown");
    if (nonUnknown.length === 0) return TUnknown;

    const containsNull = nonUnknown.some((t) => this.isNullableType(t));
    const baseTypes: JetType[] = [];
    for (const type of nonUnknown) {
      if (type.kind === "null") continue;
      if (type.kind === "nullable") baseTypes.push(withoutNull(type.innerType));
      else baseTypes.push(type);
    }

    let baseType: JetType;
    if (baseTypes.length === 0) {
      baseType = TUnknown;
    } else if (baseTypes.every((t) => t.kind === "int")) {
      baseType = TInt;
    } else if (baseTypes.every((t) => isNumeric(t))) {
      baseType = TFloat;
    } else if (baseTypes.slice(1).every((t) => typeEquals(t, baseTypes[0]))) {
      baseType = baseTypes[0];
    } else {
      baseType = TUnknown;
    }

    if (containsNull && baseType.kind !== "unknown") return asNullable(baseType);
    if (containsNull && baseTypes.length === 0) return asNullable(TUnknown);
    return baseType;
  }

  private extractNullConditionNarrowing(expr: Expression): NullConditionNarrowing | null {
    if (expr.kind !== "BinaryOp") return null;
    if (expr.operator.type !== TokenType.EQ_EQ && expr.operator.type !== TokenType.BANG_EQ) return null;

    let identifierName: string | null = null;
    if (expr.left.kind === "Identifier" && expr.right.kind === "NullLiteral") {
      identifierName = expr.left.name;
    } else if (expr.right.kind === "Identifier" && expr.left.kind === "NullLiteral") {
      identifierName = expr.right.name;
    }
    if (identifierName === null) return null;

    const currentType = this.lookupType(identifierName);
    if (currentType == null) return null;
    if (!this.isNullableType(currentType) && currentType.kind !== "unknown") return null;

    const nonNullType =
      currentType.kind === "null" ? TUnknown : currentType.kind === "nullable" ? currentType.innerType : currentType;

    if (expr.operator.type === TokenType.BANG_EQ) {
      return {
        whenTrue: new Map([[identifierName, nonNullType]]),
        whenFalse: new Map([[identifierName, TNull]]),
      };
    }
    return {
      whenTrue: new Map([[identifierName, TNull]]),
      whenFalse: new Map([[identifierName, nonNullType]]),
    };
  }

  private refineIdentifierType(name: string, currentType: JetType, valueType: JetType): void {
    let refinedType: JetType;
    if (currentType.kind === "unknown" && valueType.kind === "null") {
      refinedType = asNullable(TUnknown);
    } else if (currentType.kind === "unknown") {
      refinedType = valueType;
    } else if (
      currentType.kind === "nullable" &&
      currentType.innerType.kind === "unknown" &&
      valueType.kind !== "null"
    ) {
      refinedType = asNullable(valueType);
    } else {
      return;
    }
    for (let i = this.typeScopes.length - 1; i >= 0; i--) {
      if (this.typeScopes[i].has(name)) {
        this.typeScopes[i].set(name, refinedType);
        return;
      }
    }
  }

  private applyTypeOverrides(overrides: Map<string, JetType>): void {
    for (const [name, type] of overrides) {
      for (let i = this.typeScopes.length - 1; i >= 0; i--) {
        if (this.typeScopes[i].has(name)) {
          this.typeScopes[i].set(name, type);
          break;
        }
      }
    }
  }

  private withTemporaryTypes<T>(overrides: Map<string, JetType>, action: () => T): T {
    this.pushScope();
    for (const [name, type] of overrides) this.defineType(name, type);
    try {
      return action();
    } finally {
      this.popScope();
    }
  }

  private withThreadBoundary<T>(action: () => T): T {
    const prevReturnType = this.currentReturnType;
    this.currentReturnType = null;
    try {
      return action();
    } finally {
      this.currentReturnType = prevReturnType;
    }
  }

  private evaluateConstantValue(expr: Expression): ConstantValue | null {
    const value = this.evaluateConstantInt(expr);
    return value === null ? null : { kind: "int", value };
  }

  private evaluateConstantInt(expr: Expression): number | null {
    switch (expr.kind) {
      case "IntLiteral":
        return expr.value;
      case "Identifier": {
        const constValue = this.lookupConstValue(expr.name);
        return constValue?.kind === "int" ? constValue.value : null;
      }
      case "UnaryOp":
        if (expr.operator.type === TokenType.MINUS) {
          const operand = this.evaluateConstantInt(expr.operand);
          return operand === null ? null : -operand;
        }
        return null;
      case "BinaryOp": {
        const left = this.evaluateConstantInt(expr.left);
        if (left === null) return null;
        const right = this.evaluateConstantInt(expr.right);
        if (right === null) return null;
        switch (expr.operator.type) {
          case TokenType.PLUS: return left + right;
          case TokenType.MINUS: return left - right;
          case TokenType.STAR: return left * right;
          case TokenType.SLASH: return right === 0 ? null : Math.trunc(left / right);
          case TokenType.PERCENT: return right === 0 ? null : left % right;
          case TokenType.STAR_STAR: {
            if (right < 0) return null;
            let acc = 1;
            for (let i = 0; i < right; i++) acc *= left;
            return acc;
          }
          default: return null;
        }
      }
      case "Ternary": {
        const condition = this.evaluateConstantBoolean(expr.condition);
        if (condition === null) return null;
        return condition ? this.evaluateConstantInt(expr.thenExpr) : this.evaluateConstantInt(expr.elseExpr);
      }
      default:
        return null;
    }
  }

  private evaluateConstantBoolean(expr: Expression): boolean | null {
    switch (expr.kind) {
      case "BoolLiteral":
        return expr.value;
      case "Identifier":
        return null;
      case "BinaryOp": {
        if (expr.operator.type === TokenType.EQ_EQ || expr.operator.type === TokenType.BANG_EQ) {
          const left = this.evaluateConstantInt(expr.left);
          const right = this.evaluateConstantInt(expr.right);
          if (left !== null && right !== null) {
            return expr.operator.type === TokenType.EQ_EQ ? left === right : left !== right;
          }
          return null;
        }
        return null;
      }
      default:
        return null;
    }
  }

  private refineModuleCallReturnType(
    moduleName: string,
    member: string,
    args: Expression[],
    validatedType: JetType,
  ): JetType {
    if (moduleName === "math" && member === "round" && args.length === 2) {
      if (this.evaluateConstantInt(args[1]) === 0) return TInt;
    }
    return validatedType;
  }

  private inferExpr(expr: Expression): JetType {
    switch (expr.kind) {
      case "IntLiteral": return TInt;
      case "FloatLiteral": return TFloat;
      case "StringLiteral": return TString;
      case "BoolLiteral": return TBool;
      case "NullLiteral": return TNull;
      case "InterpolatedString": return TString;
      case "ListLiteral": {
        const elementTypeList = expr.elements.map((e) => this.inferExpr(e));
        let elementType: JetType;
        if (elementTypeList.length === 0) {
          elementType = TUnknown;
        } else {
          const commonType = this.commonSupertype(elementTypeList);
          if (commonType.kind === "unknown") {
            const first = elementTypeList[0];
            const mismatch = elementTypeList.find((t) => !accepts(first, t) && !accepts(t, first));
            if (mismatch !== undefined) {
              this.report(
                `List element type mismatch: expected '${typeToString(first)}' but got '${typeToString(mismatch)}'`,
                expr.line,
              );
            }
          }
          elementType = commonType;
        }
        return TList(elementType);
      }
      case "ObjectLiteral": return TObject;
      case "Identifier": {
        const t = this.lookupType(expr.name);
        if (t == null && !(this.typeProvider?.isKnownGlobal(expr.name) ?? false)) {
          this.report(`Undefined identifier '${expr.name}'`, expr.line);
        }
        return t ?? TUnknown;
      }
      case "Ternary": {
        this.checkCondition(expr.condition);
        const thenType = this.inferExpr(expr.thenExpr);
        const elseType = this.inferExpr(expr.elseExpr);
        return this.commonSupertype([thenType, elseType]);
      }
      case "Range": {
        const startType = this.inferExpr(expr.start);
        const endType = this.inferExpr(expr.end);
        if (this.isNullableType(startType)) {
          this.report("Range start cannot be nullable", expr.line);
        } else if (startType.kind !== "unknown" && startType.kind !== "int") {
          this.report(`Range start must be int, got '${typeToString(startType)}'`, expr.line);
        }
        if (this.isNullableType(endType)) {
          this.report("Range end cannot be nullable", expr.line);
        } else if (endType.kind !== "unknown" && endType.kind !== "int") {
          this.report(`Range end must be int, got '${typeToString(endType)}'`, expr.line);
        }
        return TList(TInt);
      }
      case "BinaryOp": return this.inferBinaryOp(expr);
      case "UnaryOp": return this.inferUnaryOp(expr);
      case "Call": return this.inferCall(expr);
      case "ThreadCall": return this.inferCall(expr.call);
      case "ThreadBlock":
        return this.withThreadBoundary(() => {
          this.checkStmt(expr.statement);
          return TNull;
        });
      case "MemberAccess": return this.inferMemberAccess(expr);
      case "IndexAccess": return this.inferIndexAccess(expr);
      case "Assign": {
        const valueType = this.inferExpr(expr.value);
        const targetType = this.inferExpr(expr.target);
        if (expr.target.kind === "Identifier") {
          if (this.isConst(expr.target.name)) {
            this.report(`Cannot reassign const variable '${expr.target.name}'`, expr.line);
          } else if (this.isReadOnly(expr.target.name)) {
            this.report(`Cannot reassign foreach item '${expr.target.name}'`, expr.line);
          }
        }
        if (!accepts(targetType, valueType) && targetType.kind !== "unknown") {
          this.report(`Expected type '${typeToString(targetType)}' but got '${typeToString(valueType)}'`, expr.line);
        }
        if (expr.target.kind === "Identifier") {
          this.refineIdentifierType(expr.target.name, targetType, valueType);
        }
        return valueType;
      }
      case "CompoundAssign": return this.inferCompoundAssign(expr);
    }
  }

  private inferCompoundAssign(expr: Expression & { kind: "CompoundAssign" }): JetType {
    const targetType = this.inferExpr(expr.target);
    const valueType = this.inferExpr(expr.value);
    if (expr.target.kind === "Identifier") {
      if (this.isConst(expr.target.name)) {
        this.report(`Cannot reassign const variable '${expr.target.name}'`, expr.line);
      } else if (this.isReadOnly(expr.target.name)) {
        this.report(`Cannot reassign foreach item '${expr.target.name}'`, expr.line);
      }
    }
    if (this.isNullableType(targetType)) {
      this.report(
        `Compound assignment cannot be applied to nullable type '${typeToString(targetType)}'`,
        expr.line,
      );
      return TUnknown;
    }
    const op = expr.operator.type;
    if (op === TokenType.PLUS_ASSIGN && targetType.kind === "string") {
      if (valueType.kind !== "string" && valueType.kind !== "unknown") {
        this.report(`String '+=' requires a string operand, got '${typeToString(valueType)}'`, expr.line);
      }
      return TString;
    }
    if (op === TokenType.STAR_ASSIGN && targetType.kind === "string") {
      if (valueType.kind !== "int" && valueType.kind !== "unknown") {
        this.report(`String '*=' requires an int operand, got '${typeToString(valueType)}'`, expr.line);
      }
      return TString;
    }
    if (op === TokenType.PLUS_ASSIGN && targetType.kind === "list") {
      if (valueType.kind === "list") {
        const te = targetType.elementType;
        const ve = valueType.elementType;
        if (te.kind !== "unknown" && ve.kind !== "unknown" && !accepts(te, ve)) {
          this.report(
            `Cannot concatenate lists with different element types: '${typeToString(targetType)}' and '${typeToString(valueType)}'`,
            expr.line,
          );
        }
      } else if (valueType.kind !== "unknown") {
        this.report(`List '+=' requires a list operand, got '${typeToString(valueType)}'`, expr.line);
      }
      return targetType;
    }
    if (isNumeric(targetType) || targetType.kind === "unknown") {
      if (valueType.kind !== "unknown" && !isNumeric(valueType)) {
        this.report(`Compound assignment requires numeric operands, got '${typeToString(valueType)}'`, expr.line);
      }
      return targetType;
    }
    this.report(
      `Operator '${expr.operator.value}' cannot be applied to type '${typeToString(targetType)}'`,
      expr.line,
    );
    return TUnknown;
  }

  private inferBinaryOp(expr: Expression & { kind: "BinaryOp" }): JetType {
    const op = expr.operator.type;
    if (op === TokenType.AMP_AMP || op === TokenType.PIPE_PIPE) {
      const leftType = this.inferExpr(expr.left);
      const narrowing = this.extractNullConditionNarrowing(expr.left);
      let rightType: JetType;
      if (narrowing === null) {
        rightType = this.inferExpr(expr.right);
      } else if (op === TokenType.AMP_AMP) {
        rightType = this.withTemporaryTypes(narrowing.whenTrue, () => this.inferExpr(expr.right));
      } else {
        rightType = this.withTemporaryTypes(narrowing.whenFalse, () => this.inferExpr(expr.right));
      }
      if (leftType.kind === "null") {
        this.report(`Operator '${expr.operator.value}' cannot be applied to null`, expr.line);
      }
      if (rightType.kind === "null") {
        this.report(`Operator '${expr.operator.value}' cannot be applied to null`, expr.line);
      }
      return TBool;
    }

    const left = this.inferExpr(expr.left);
    const right = this.inferExpr(expr.right);

    if (op === TokenType.EQ_EQ || op === TokenType.BANG_EQ) return TBool;

    if (COMPARISON_OPS.has(op)) {
      if (this.isNullableType(left)) {
        this.report(
          `Operator '${expr.operator.value}' cannot be applied to nullable type '${typeToString(left)}'`,
          expr.line,
        );
      } else if (left.kind !== "unknown" && !isNumeric(left)) {
        this.report(`Operator '${expr.operator.value}' requires numeric operands, got '${typeToString(left)}'`, expr.line);
      }
      if (this.isNullableType(right)) {
        this.report(
          `Operator '${expr.operator.value}' cannot be applied to nullable type '${typeToString(right)}'`,
          expr.line,
        );
      } else if (right.kind !== "unknown" && !isNumeric(right)) {
        this.report(`Operator '${expr.operator.value}' requires numeric operands, got '${typeToString(right)}'`, expr.line);
      }
      return TBool;
    }

    if (op === TokenType.PLUS && left.kind === "string" && right.kind === "string") return TString;
    if (op === TokenType.PLUS && left.kind === "list" && right.kind === "list") {
      const le = left.elementType;
      const re = right.elementType;
      if (le.kind !== "unknown" && re.kind !== "unknown" && !accepts(le, re)) {
        this.report(
          `Cannot concatenate lists with different element types: '${typeToString(left)}' and '${typeToString(right)}'`,
          expr.line,
        );
      }
      return TList(this.commonSupertype([le, re]));
    }
    if (op === TokenType.STAR && left.kind === "string" && right.kind === "int") return TString;
    if (op === TokenType.STAR && left.kind === "int" && right.kind === "string") return TString;

    if (isNumeric(left) && isNumeric(right)) {
      if (op === TokenType.STAR_STAR) return TFloat;
      if (left.kind === "int" && right.kind === "int") return TInt;
      return TFloat;
    }

    if (op === TokenType.KW_IN) {
      if (this.isNullableType(left)) {
        this.report(`Operator 'in' cannot be applied to nullable type '${typeToString(left)}'`, expr.line);
      }
      if (right.kind === "object") {
        if (left.kind !== "string" && left.kind !== "unknown") {
          this.report(`'in' on object requires a string operand, got '${typeToString(left)}'`, expr.line);
        }
      } else if (right.kind === "string") {
        if (left.kind !== "string" && left.kind !== "unknown") {
          this.report(`'in' on string requires a string operand, got '${typeToString(left)}'`, expr.line);
        }
      } else if (right.kind !== "list" && right.kind !== "unknown") {
        this.report(`Operator 'in' cannot be applied to type '${typeToString(right)}'`, expr.line);
      }
      return TBool;
    }

    if (this.isNullableType(left) || this.isNullableType(right)) {
      const nullableType = this.isNullableType(left) ? left : right;
      this.report(
        `Operator '${expr.operator.value}' cannot be applied to nullable type '${typeToString(nullableType)}'`,
        expr.line,
      );
      return TUnknown;
    }
    if (left.kind === "unknown" || right.kind === "unknown") return TUnknown;

    this.report(
      `Operator '${expr.operator.value}' cannot be applied to types '${typeToString(left)}' and '${typeToString(right)}'`,
      expr.line,
    );
    return TUnknown;
  }

  private inferUnaryOp(expr: Expression & { kind: "UnaryOp" }): JetType {
    const operand = this.inferExpr(expr.operand);
    switch (expr.operator.type) {
      case TokenType.BANG:
        if (operand.kind === "null") this.report("Operator '!' cannot be applied to null", expr.line);
        return TBool;
      case TokenType.MINUS:
        if (this.isNullableType(operand)) {
          this.report(`Operator '-' cannot be applied to nullable type '${typeToString(operand)}'`, expr.line);
          return TUnknown;
        }
        if (isNumeric(operand) || operand.kind === "unknown") return operand;
        this.report(`Operator '-' requires a numeric operand, got '${typeToString(operand)}'`, expr.line);
        return TUnknown;
      case TokenType.PLUS_PLUS:
      case TokenType.MINUS_MINUS:
        this.checkMutationTarget(expr.operand, operand, expr.line, expr.operator.value);
        return operand;
      default:
        return TUnknown;
    }
  }

  private inferCall(expr: Expression & { kind: "Call" }): JetType {
    if (expr.callee.kind === "MemberAccess") {
      const target = expr.callee.target;
      const member = expr.callee.member;
      const argTypes = expr.arguments.map((a) => this.inferExpr(a));
      const targetType = this.inferExpr(target);
      if (this.isNullableType(targetType)) {
        this.report(`Cannot call method '${member}' on nullable type '${typeToString(targetType)}'`, expr.line);
        return TUnknown;
      }
      if (targetType.kind === "module") {
        const fieldType = targetType.fields.get(member);
        if (fieldType === undefined) {
          this.report(`Module member '${member}' does not exist`, expr.line);
          return TUnknown;
        }
        const validated = this.validateCallableType(fieldType, argTypes, expr.line, `Module member '${member}'`);
        const moduleName = target.kind === "Identifier" ? target.name : "";
        return this.refineModuleCallReturnType(moduleName, member, expr.arguments, validated);
      }
      const builtinMethodType = this.typeProvider?.methodType(targetType, member) ?? null;
      if (builtinMethodType !== null) {
        if ((member === "ascend" || member === "descend") && targetType.kind === "list") {
          const elementType = targetType.elementType;
          if (
            elementType.kind !== "unknown" &&
            elementType.kind !== "int" &&
            elementType.kind !== "float" &&
            elementType.kind !== "string"
          ) {
            this.report(
              `Method '${member}' requires list elements to be int, float, or string, got '${typeToString(elementType)}'`,
              expr.line,
            );
          }
        }
        return this.validateCallableType(builtinMethodType, argTypes, expr.line, `Method '${member}'`);
      }
      if (targetType.kind !== "unknown" && targetType.kind !== "object" && targetType.kind !== "command") {
        this.report(`Type '${typeToString(targetType)}' has no method '${member}'`, expr.line);
      }
      return TUnknown;
    }

    const argTypes = expr.arguments.map((a) => this.inferExpr(a));
    if (expr.callee.kind === "Identifier") {
      const calleeName = expr.callee.name;
      const globalType = this.typeProvider?.globalType(calleeName) ?? null;
      if (globalType !== null) {
        return this.validateCallableType(globalType, argTypes, expr.line, `Function '${calleeName}'`);
      }
      const functionType = this.lookupType(calleeName);
      if (functionType?.kind === "command") {
        this.report(`'${calleeName}' is a command and cannot be called as a function`, expr.line);
        return TUnknown;
      }
      if (functionType?.kind === "callable") {
        return this.validateCallableInvocation(functionType, argTypes, expr.line, `Function '${calleeName}'`);
      }
      if (functionType == null || functionType.kind === "unknown" || functionType.kind === "function") {
        return TUnknown;
      }
      this.report(`Identifier '${calleeName}' is not callable`, expr.line);
      return TUnknown;
    }

    const calleeType = this.inferExpr(expr.callee);
    if (calleeType.kind !== "callable" && calleeType.kind !== "function" && calleeType.kind !== "unknown") {
      this.report(`Value of type '${typeToString(calleeType)}' is not callable`, expr.line);
    }
    return TUnknown;
  }

  private inferMemberAccess(expr: Expression & { kind: "MemberAccess" }): JetType {
    const targetType = this.inferExpr(expr.target);
    if (this.isNullableType(targetType)) {
      this.report(`Cannot access member '${expr.member}' on nullable type '${typeToString(targetType)}'`, expr.line);
      return TUnknown;
    }
    if (targetType.kind === "module") {
      const fieldType = targetType.fields.get(expr.member);
      if (fieldType === undefined) {
        this.report(`Module member '${expr.member}' does not exist`, expr.line);
        return TUnknown;
      }
      return fieldType.kind === "callable" ? TFunction : fieldType;
    }
    const builtinMethodType = this.typeProvider?.methodType(targetType, expr.member) ?? null;
    if (builtinMethodType?.kind === "callable" && targetType.kind !== "unknown" && targetType.kind !== "object") {
      this.report(
        `Member '${expr.member}' on type '${typeToString(targetType)}' is a method and must be called with parentheses`,
        expr.line,
      );
    }
    if (
      builtinMethodType === null &&
      targetType.kind !== "unknown" &&
      targetType.kind !== "object" &&
      targetType.kind !== "command"
    ) {
      this.report(`Type '${typeToString(targetType)}' has no member '${expr.member}'`, expr.line);
    }
    return TUnknown;
  }

  private inferIndexAccess(expr: Expression & { kind: "IndexAccess" }): JetType {
    const targetType = this.inferExpr(expr.target);
    const indexType = this.inferExpr(expr.index);
    if (this.isNullableType(targetType)) {
      this.report(`Cannot index nullable type '${typeToString(targetType)}'`, expr.line);
      return TUnknown;
    }
    switch (targetType.kind) {
      case "list":
        if (indexType.kind !== "unknown" && indexType.kind !== "int") {
          this.report(`List index must be an int, got '${typeToString(indexType)}'`, expr.line);
        }
        return targetType.elementType;
      case "string":
        if (indexType.kind !== "unknown" && indexType.kind !== "int") {
          this.report(`String index must be an int, got '${typeToString(indexType)}'`, expr.line);
        }
        return TString;
      case "object":
        if (indexType.kind !== "unknown" && indexType.kind !== "string") {
          this.report(`Object index must be a string, got '${typeToString(indexType)}'`, expr.line);
        }
        return TUnknown;
      default:
        if (targetType.kind !== "unknown") {
          this.report(`Type '${typeToString(targetType)}' does not support index access`, expr.line);
        }
        return TUnknown;
    }
  }

  private validateCallableType(type: JetType, argTypes: JetType[], line: number, calleeLabel: string): JetType {
    if (type.kind !== "callable") {
      this.report(`${calleeLabel} is not callable`, line);
      return TUnknown;
    }
    return this.validateCallableInvocation(type, argTypes, line, calleeLabel);
  }

  private validateCallableInvocation(
    callable: JetType & { kind: "callable" },
    argTypes: JetType[],
    line: number,
    calleeLabel: string,
  ): JetType {
    if (callable.signatures.length === 0) return callable.returnType;
    const matches: { score: number; signature: CallSignature }[] = [];
    for (const sig of callable.signatures) {
      const score = signatureMatchScore(sig, argTypes);
      if (score !== null) matches.push({ score, signature: sig });
    }
    if (matches.length > 0) {
      const bestScore = Math.min(...matches.map((m) => m.score));
      const bestMatches = matches.filter((m) => m.score === bestScore).map((m) => m.signature);
      return this.commonSupertype(bestMatches.map((sig) => sig.returnType ?? callable.returnType));
    }
    const expected = callable.signatures.map((sig) => signatureDescribe(sig)).join(" or ");
    const actual = `(${argTypes.map((t) => typeToString(t)).join(", ")})`;
    this.report(`${calleeLabel} expects ${expected} but got ${actual}`, line);
    return callable.returnType;
  }

  private pushScope(): void {
    this.typeScopes.push(new Map());
    this.constScopes.push(new Set());
    this.readOnlyScopes.push(new Set());
    this.constValueScopes.push(new Map());
  }

  private popScope(): void {
    this.typeScopes.pop();
    this.constScopes.pop();
    this.readOnlyScopes.pop();
    this.constValueScopes.pop();
  }

  private currentTypeScope(): Map<string, JetType> {
    return this.typeScopes[this.typeScopes.length - 1];
  }

  private defineType(name: string, type: JetType, isConst = false, constValue: ConstantValue | null = null): void {
    this.currentTypeScope().set(name, type);
    if (isConst) {
      this.constScopes[this.constScopes.length - 1].add(name);
      if (constValue !== null) {
        this.constValueScopes[this.constValueScopes.length - 1].set(name, constValue);
      }
    }
  }

  private defineReadOnly(name: string, type: JetType): void {
    this.defineType(name, type);
    this.readOnlyScopes[this.readOnlyScopes.length - 1].add(name);
  }

  private isConst(name: string): boolean {
    for (let i = this.constScopes.length - 1; i >= 0; i--) {
      if (this.typeScopes[i].has(name)) return this.constScopes[i].has(name);
    }
    return false;
  }

  private isReadOnly(name: string): boolean {
    for (let i = this.readOnlyScopes.length - 1; i >= 0; i--) {
      if (this.typeScopes[i].has(name)) return this.readOnlyScopes[i].has(name);
    }
    return false;
  }

  private lookupType(name: string): JetType | null {
    for (let i = this.typeScopes.length - 1; i >= 0; i--) {
      const type = this.typeScopes[i].get(name);
      if (type !== undefined) return type;
    }
    return null;
  }

  private lookupConstValue(name: string): ConstantValue | null {
    for (let i = this.constValueScopes.length - 1; i >= 0; i--) {
      const value = this.constValueScopes[i].get(name);
      if (value !== undefined) return value;
    }
    return null;
  }

  private hoistFunction(stmt: Statement & { kind: "FunctionDecl" }): void {
    const retType = stmt.returnType ? typeRefToJetType(stmt.returnType) : TUnknown;
    this.currentTypeScope().set(stmt.name, TCallable(retType, [paramsToCallSignature(stmt.params)]));
  }

  private enumType(stmt: EnumDecl): JetType {
    return TModule(new Map(stmt.entries.map((entry) => [entry.name, this.enumValueType(entry.value)])));
  }

  private enumValueType(value: EnumValue): JetType {
    switch (value.kind) {
      case "int": return TInt;
      case "float": return TFloat;
      case "string": return TString;
      case "bool": return TBool;
    }
  }

  private resolveTypeRef(typeRef: TypeRef, line: number, context: string): JetType {
    const resolved = typeRefToJetTypeOrNull(typeRef);
    if (resolved !== null) return resolved;
    this.report(`Unsupported type '${this.formatTypeRef(typeRef)}' in ${context}`, line);
    return TUnknown;
  }

  private formatTypeRef(typeRef: TypeRef): string {
    if (typeRef.name === "list") {
      return `list<${typeRef.typeArgRef ? this.formatTypeRef(typeRef.typeArgRef) : "unknown"}>`;
    }
    return typeRef.name;
  }

  private isThreadResultTarget(expr: Expression): boolean {
    switch (expr.kind) {
      case "MemberAccess":
      case "IndexAccess":
        return this.startsWithThreadResult(expr.target);
      default:
        return false;
    }
  }

  private startsWithThreadResult(expr: Expression): boolean {
    switch (expr.kind) {
      case "ThreadCall":
      case "ThreadBlock":
        return true;
      case "MemberAccess":
      case "IndexAccess":
        return this.startsWithThreadResult(expr.target);
      default:
        return false;
    }
  }

  private checkMutationTarget(target: Expression, targetType: JetType, line: number, operator: string): void {
    const isAssignable =
      target.kind === "Identifier" || target.kind === "MemberAccess" || target.kind === "IndexAccess";
    if (!isAssignable) {
      this.report(`Operator '${operator}' requires an assignable target`, line);
      return;
    }
    if (this.isThreadResultTarget(target)) {
      this.report("Cannot mutate a threaded result target", line);
      return;
    }
    if (target.kind === "Identifier") {
      if (this.isConst(target.name)) {
        this.report(`Cannot reassign const variable '${target.name}'`, line);
      } else if (this.isReadOnly(target.name)) {
        this.report(`Cannot reassign foreach item '${target.name}'`, line);
      }
    }
    if (this.isNullableType(targetType)) {
      this.report(`Operator '${operator}' cannot be applied to nullable type '${typeToString(targetType)}'`, line);
    } else if (targetType.kind !== "unknown" && !isNumeric(targetType)) {
      this.report(`Operator '${operator}' requires a numeric target, got '${typeToString(targetType)}'`, line);
    }
  }

  private isConstantExpression(expr: Expression): boolean {
    switch (expr.kind) {
      case "IntLiteral":
      case "FloatLiteral":
      case "StringLiteral":
      case "BoolLiteral":
      case "NullLiteral":
        return true;
      case "InterpolatedString":
        return expr.parts.every(
          (part) => part.kind === "literal" || (part.kind === "expr" && this.isConstantExpression(part.expression)),
        );
      case "ListLiteral":
        return expr.elements.every((e) => this.isConstantExpression(e));
      case "ObjectLiteral":
        return expr.entries.every((entry) => this.isConstantExpression(entry.value));
      case "Identifier":
        return this.isConst(expr.name);
      case "BinaryOp":
        return this.isConstantExpression(expr.left) && this.isConstantExpression(expr.right);
      case "UnaryOp":
        return this.isConstantExpression(expr.operand);
      case "Ternary":
        return (
          this.isConstantExpression(expr.condition) &&
          this.isConstantExpression(expr.thenExpr) &&
          this.isConstantExpression(expr.elseExpr)
        );
      case "Range":
        return this.isConstantExpression(expr.start) && this.isConstantExpression(expr.end);
      default:
        return false;
    }
  }

  private hasRequiredReturns(stmts: Statement[]): boolean {
    return !this.analyzeBlockFlow(stmts).has(FlowSignal.FALLTHROUGH);
  }

  private analyzeBlockFlow(stmts: Statement[]): Set<FlowSignal> {
    const outcomes = new Set<FlowSignal>([FlowSignal.FALLTHROUGH]);
    for (const stmt of stmts) {
      if (!outcomes.has(FlowSignal.FALLTHROUGH)) break;
      outcomes.delete(FlowSignal.FALLTHROUGH);
      for (const signal of this.analyzeStmtFlow(stmt)) outcomes.add(signal);
    }
    return outcomes;
  }

  private analyzeStmtFlow(stmt: Statement): Set<FlowSignal> {
    switch (stmt.kind) {
      case "ReturnStmt":
        return new Set([FlowSignal.RETURN]);
      case "BreakStmt":
        return new Set([FlowSignal.BREAK]);
      case "ContinueStmt":
        return new Set([FlowSignal.CONTINUE]);
      case "IfStmt": {
        const outcomes = new Set<FlowSignal>();
        for (const signal of this.analyzeBlockFlow(stmt.thenBody)) outcomes.add(signal);
        for (const clause of stmt.elseIfClauses) {
          for (const signal of this.analyzeBlockFlow(clause.body)) outcomes.add(signal);
        }
        if (stmt.elseBody !== null) {
          for (const signal of this.analyzeBlockFlow(stmt.elseBody)) outcomes.add(signal);
        } else {
          outcomes.add(FlowSignal.FALLTHROUGH);
        }
        return outcomes;
      }
      case "WhileStmt":
      case "ForEachStmt":
        return new Set([FlowSignal.NON_TERMINATING]);
      case "TryStmt":
        return this.analyzeTryFlow(stmt);
      default:
        return new Set([FlowSignal.FALLTHROUGH]);
    }
  }

  private analyzeTryFlow(stmt: Statement & { kind: "TryStmt" }): Set<FlowSignal> {
    const outcomes = new Set<FlowSignal>();
    for (const signal of this.analyzeBlockFlow(stmt.tryBody)) outcomes.add(signal);
    for (const catchClause of stmt.catches) {
      for (const signal of this.analyzeBlockFlow(catchClause.body)) outcomes.add(signal);
    }
    if (stmt.finallyBody === null) return outcomes;
    const finallyOutcomes = this.analyzeBlockFlow(stmt.finallyBody);
    if (!finallyOutcomes.has(FlowSignal.FALLTHROUGH)) return finallyOutcomes;
    const combined = new Set<FlowSignal>(outcomes);
    for (const signal of finallyOutcomes) {
      if (signal !== FlowSignal.FALLTHROUGH) combined.add(signal);
    }
    return combined;
  }

  private report(message: string, line: number): void {
    this.errors.push({ message, line });
  }
}
