import { Token } from "./token";

export interface Span {
  start: number;
  end: number;
}

export type AccessModifier = "public" | "private" | "protected";

export interface TypeRef {
  name: string;
  typeArgRef: TypeRef | null;
  span: Span;
}

export interface Param {
  typeName: TypeRef | null;
  name: string;
  nameSpan: Span;
  default: Expression | null;
  span: Span;
}

export interface DeconstructionBinding {
  name: string | null;
  typeName: TypeRef | null;
  nameSpan: Span | null;
  span: Span;
}

export interface CatchClause {
  exceptionType: string | null;
  variableName: string | null;
  variableNameSpan: Span | null;
  body: Statement[];
  line: number;
  span: Span;
}

export interface ListenerAnnotations {
  priority: string | null;
  ignoreCancelled: boolean;
}

export const EMPTY_LISTENER_ANNOTATIONS: ListenerAnnotations = {
  priority: null,
  ignoreCancelled: false,
};

export interface CommandAnnotations {
  description: string | null;
  permission: string | null;
  permissionMessage: string | null;
  usage: string | null;
  aliases: string[];
}

export const EMPTY_COMMAND_ANNOTATIONS: CommandAnnotations = {
  description: null,
  permission: null,
  permissionMessage: null,
  usage: null,
  aliases: [],
};

export type ManifestValue =
  | { kind: "scalar"; value: string }
  | { kind: "list"; values: string[] };

export type CommandBodyItem =
  | { kind: "code"; stmt: Statement }
  | { kind: "subcommand"; decl: CommandDecl }
  | { kind: "default"; body: Statement[] };

export interface IntLiteral { kind: "IntLiteral"; value: number; line: number; span: Span; }
export interface FloatLiteral { kind: "FloatLiteral"; value: number; line: number; span: Span; }
export interface StringLiteral { kind: "StringLiteral"; value: string; line: number; span: Span; }
export interface BoolLiteral { kind: "BoolLiteral"; value: boolean; line: number; span: Span; }
export interface NullLiteral { kind: "NullLiteral"; line: number; span: Span; }

export type InterpolationPart =
  | { kind: "literal"; text: string }
  | { kind: "expr"; expression: Expression };

export interface InterpolatedString {
  kind: "InterpolatedString";
  parts: InterpolationPart[];
  line: number;
  span: Span;
}

export interface ListLiteral {
  kind: "ListLiteral";
  elements: Expression[];
  line: number;
  span: Span;
}

export interface ObjectEntry {
  key: string;
  value: Expression;
  keySpan: Span;
}

export interface ObjectLiteral {
  kind: "ObjectLiteral";
  entries: ObjectEntry[];
  line: number;
  span: Span;
}

export interface Identifier {
  kind: "Identifier";
  name: string;
  line: number;
  span: Span;
}

export interface BinaryOp {
  kind: "BinaryOp";
  left: Expression;
  operator: Token;
  right: Expression;
  line: number;
  span: Span;
}

export interface UnaryOp {
  kind: "UnaryOp";
  operator: Token;
  operand: Expression;
  prefix: boolean;
  line: number;
  span: Span;
}

export interface Ternary {
  kind: "Ternary";
  condition: Expression;
  thenExpr: Expression;
  elseExpr: Expression;
  line: number;
  span: Span;
}

export interface Range {
  kind: "Range";
  start: Expression;
  end: Expression;
  inclusive: boolean;
  line: number;
  span: Span;
}

export interface Call {
  kind: "Call";
  callee: Expression;
  arguments: Expression[];
  line: number;
  span: Span;
}

export interface ThreadCall {
  kind: "ThreadCall";
  call: Call;
  line: number;
  span: Span;
}

export interface ThreadBlock {
  kind: "ThreadBlock";
  statement: Statement;
  line: number;
  span: Span;
}

export interface MemberAccess {
  kind: "MemberAccess";
  target: Expression;
  member: string;
  memberSpan: Span;
  line: number;
  span: Span;
}

export interface IndexAccess {
  kind: "IndexAccess";
  target: Expression;
  index: Expression;
  line: number;
  span: Span;
}

export interface Assign {
  kind: "Assign";
  target: Expression;
  value: Expression;
  line: number;
  span: Span;
}

export interface CompoundAssign {
  kind: "CompoundAssign";
  target: Expression;
  operator: Token;
  value: Expression;
  line: number;
  span: Span;
}

export type Expression =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | NullLiteral
  | InterpolatedString
  | ListLiteral
  | ObjectLiteral
  | Identifier
  | BinaryOp
  | UnaryOp
  | Ternary
  | Range
  | Call
  | ThreadCall
  | ThreadBlock
  | MemberAccess
  | IndexAccess
  | Assign
  | CompoundAssign;

export interface Metadata {
  kind: "Metadata";
  key: string;
  value: string;
  line: number;
  span: Span;
}

export interface Using {
  kind: "Using";
  relativeDots: number;
  path: string[];
  recursive: boolean;
  alias: string | null;
  line: number;
  span: Span;
}

export interface Manifest {
  kind: "Manifest";
  entries: Map<string, ManifestValue>;
  line: number;
  span: Span;
}

export interface VarDecl {
  kind: "VarDecl";
  access: AccessModifier;
  isConst: boolean;
  typeName: TypeRef;
  name: string;
  nameSpan: Span;
  initializer: Expression;
  line: number;
  span: Span;
}

export interface ExprStatement {
  kind: "ExprStatement";
  expression: Expression;
  line: number;
  span: Span;
}

export interface FunctionDecl {
  kind: "FunctionDecl";
  access: AccessModifier;
  name: string;
  nameSpan: Span;
  params: Param[];
  returnType: TypeRef | null;
  body: Statement[];
  line: number;
  span: Span;
}

export interface IntervalDecl {
  kind: "IntervalDecl";
  access: AccessModifier;
  name: string;
  nameSpan: Span;
  intervalMs: number;
  body: Statement[];
  line: number;
  span: Span;
}

export interface ListenerDecl {
  kind: "ListenerDecl";
  access: AccessModifier;
  eventType: string;
  eventTypeSpan: Span;
  name: string;
  nameSpan: Span;
  senderParam: string | null;
  senderParamSpan: Span | null;
  body: Statement[];
  annotations: ListenerAnnotations;
  line: number;
  span: Span;
}

export interface IfStmt {
  kind: "IfStmt";
  condition: Expression;
  thenBody: Statement[];
  elseIfClauses: { condition: Expression; body: Statement[] }[];
  elseBody: Statement[] | null;
  line: number;
  span: Span;
}

export interface WhileStmt {
  kind: "WhileStmt";
  condition: Expression;
  body: Statement[];
  line: number;
  span: Span;
}

export interface ForEachStmt {
  kind: "ForEachStmt";
  itemType: TypeRef | null;
  itemName: string;
  itemNameSpan: Span;
  iterable: Expression;
  body: Statement[];
  line: number;
  span: Span;
}

export interface TryStmt {
  kind: "TryStmt";
  tryBody: Statement[];
  catches: CatchClause[];
  finallyBody: Statement[] | null;
  line: number;
  span: Span;
}

export interface ReturnStmt {
  kind: "ReturnStmt";
  value: Expression | null;
  line: number;
  span: Span;
}

export interface BreakStmt { kind: "BreakStmt"; line: number; span: Span; }
export interface ContinueStmt { kind: "ContinueStmt"; line: number; span: Span; }

export interface CommandDecl {
  kind: "CommandDecl";
  access: AccessModifier;
  name: string;
  nameSpan: Span;
  senderName: string | null;
  senderNameSpan: Span | null;
  params: Param[];
  bodyItems: CommandBodyItem[];
  annotations: CommandAnnotations;
  line: number;
  span: Span;
}

export interface Deconstruction {
  kind: "Deconstruction";
  access: AccessModifier;
  isConst: boolean;
  isDeclaration: boolean;
  bindings: DeconstructionBinding[];
  initializer: Expression;
  line: number;
  span: Span;
}

export type Statement =
  | Metadata
  | Using
  | Manifest
  | VarDecl
  | ExprStatement
  | FunctionDecl
  | IntervalDecl
  | ListenerDecl
  | IfStmt
  | WhileStmt
  | ForEachStmt
  | TryStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | CommandDecl
  | Deconstruction;
