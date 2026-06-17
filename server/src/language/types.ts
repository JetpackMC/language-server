import { Param, TypeRef } from "./ast";

export type JetType =
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "string" }
  | { kind: "bool" }
  | { kind: "object" }
  | { kind: "null" }
  | { kind: "function" }
  | { kind: "interval" }
  | { kind: "schedule" }
  | { kind: "listener" }
  | { kind: "command" }
  | { kind: "unknown" }
  | { kind: "nullable"; innerType: JetType }
  | { kind: "list"; elementType: JetType }
  | { kind: "module"; fields: Map<string, JetType> }
  | { kind: "callable"; returnType: JetType; signatures: CallSignature[] };

export const TInt: JetType = Object.freeze({ kind: "int" });
export const TFloat: JetType = Object.freeze({ kind: "float" });
export const TString: JetType = Object.freeze({ kind: "string" });
export const TBool: JetType = Object.freeze({ kind: "bool" });
export const TObject: JetType = Object.freeze({ kind: "object" });
export const TNull: JetType = Object.freeze({ kind: "null" });
export const TFunction: JetType = Object.freeze({ kind: "function" });
export const TInterval: JetType = Object.freeze({ kind: "interval" });
export const TSchedule: JetType = Object.freeze({ kind: "schedule" });
export const TListener: JetType = Object.freeze({ kind: "listener" });
export const TCommand: JetType = Object.freeze({ kind: "command" });
export const TUnknown: JetType = Object.freeze({ kind: "unknown" });

export function TNullable(innerType: JetType): JetType {
  return { kind: "nullable", innerType };
}

export function TList(elementType: JetType): JetType {
  return { kind: "list", elementType };
}

export function TModule(fields: Map<string, JetType>): JetType {
  return { kind: "module", fields };
}

export function TCallable(returnType: JetType, signatures: CallSignature[] = []): JetType {
  return { kind: "callable", returnType, signatures };
}

export interface CallSignature {
  paramTypes: JetType[];
  requiredCount: number;
  variadicType: JetType | null;
  returnType: JetType | null;
}

export function typeToString(t: JetType): string {
  switch (t.kind) {
    case "int": return "int";
    case "float": return "float";
    case "string": return "string";
    case "bool": return "bool";
    case "object": return "object";
    case "null": return "null";
    case "function": return "function";
    case "interval": return "interval";
    case "schedule": return "schedule";
    case "listener": return "listener";
    case "command": return "command";
    case "unknown": return "unknown";
    case "nullable": return `${typeToString(t.innerType)}?`;
    case "list": return `list<${typeToString(t.elementType)}>`;
    case "module": return "module";
    case "callable": return `callable<${typeToString(t.returnType)}>`;
  }
}

export function typeEquals(a: JetType, b: JetType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "nullable":
      return typeEquals(a.innerType, (b as typeof a).innerType);
    case "list":
      return typeEquals(a.elementType, (b as typeof a).elementType);
    case "module":
      return mapEquals(a.fields, (b as typeof a).fields);
    case "callable": {
      const o = b as typeof a;
      return (
        typeEquals(a.returnType, o.returnType) &&
        signatureListEquals(a.signatures, o.signatures)
      );
    }
    default:
      return true;
  }
}

function mapEquals(a: Map<string, JetType>, b: Map<string, JetType>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || !typeEquals(value, other)) return false;
  }
  return true;
}

function signatureListEquals(a: CallSignature[], b: CallSignature[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((sig, i) => signatureEquals(sig, b[i]));
}

function signatureEquals(a: CallSignature, b: CallSignature): boolean {
  if (a.requiredCount !== b.requiredCount) return false;
  if (a.paramTypes.length !== b.paramTypes.length) return false;
  if (!a.paramTypes.every((t, i) => typeEquals(t, b.paramTypes[i]))) return false;
  if (!nullableTypeEquals(a.variadicType, b.variadicType)) return false;
  return nullableTypeEquals(a.returnType, b.returnType);
}

function nullableTypeEquals(a: JetType | null, b: JetType | null): boolean {
  if (a === null || b === null) return a === b;
  return typeEquals(a, b);
}

export function isNumeric(t: JetType): boolean {
  return t.kind === "int" || t.kind === "float";
}

export function isNullable(t: JetType): boolean {
  return t.kind === "null" || t.kind === "nullable";
}

export function withoutNull(t: JetType): JetType {
  return t.kind === "nullable" ? withoutNull(t.innerType) : t;
}

export function asNullable(t: JetType): JetType {
  switch (t.kind) {
    case "null": return TNull;
    case "nullable": return t;
    default: return TNullable(t);
  }
}

export function accepts(target: JetType, other: JetType): boolean {
  return matchScore(target, other) !== null;
}

export function matchScore(target: JetType, other: JetType): number | null {
  if (target.kind === "unknown" || other.kind === "unknown") return 100;
  if (typeEquals(target, other)) return 0;

  if (target.kind === "nullable") {
    if (other.kind === "null") return 0;
    const inner = matchScore(target.innerType, other);
    return inner === null ? null : inner + 10;
  }

  if (other.kind === "null") return null;

  if (target.kind === "list" && other.kind === "list") {
    const inner = matchScore(target.elementType, other.elementType);
    return inner === null ? null : inner + 1;
  }

  if (isNumeric(target) && isNumeric(other)) return 1;

  return null;
}

export function signatureAccepts(sig: CallSignature, args: JetType[]): boolean {
  return signatureMatchScore(sig, args) !== null;
}

export function signatureMatchScore(sig: CallSignature, args: JetType[]): number | null {
  if (sig.variadicType === null) {
    if (args.length < sig.requiredCount || args.length > sig.paramTypes.length) return null;
  } else if (args.length < sig.requiredCount || args.length < sig.paramTypes.length) {
    return null;
  }

  let score = 0;
  for (let i = 0; i < sig.paramTypes.length; i++) {
    if (i >= args.length) break;
    const s = matchScore(sig.paramTypes[i], args[i]);
    if (s === null) return null;
    score += s;
  }

  if (sig.variadicType !== null) {
    for (let i = sig.paramTypes.length; i < args.length; i++) {
      const s = matchScore(sig.variadicType, args[i]);
      if (s === null) return null;
      score += s;
    }
  }

  return score;
}

export function signatureDescribe(sig: CallSignature): string {
  const fixed = sig.paramTypes.map((type, index) =>
    index < sig.requiredCount ? typeToString(type) : `${typeToString(type)}?`,
  );
  if (sig.variadicType !== null) fixed.push(`${typeToString(sig.variadicType)}...`);
  return `(${fixed.join(", ")})`;
}

export function signature(
  paramTypes: JetType[],
  options: { requiredCount?: number; variadicType?: JetType | null; returnType?: JetType | null } = {},
): CallSignature {
  const requiredCount = options.requiredCount ?? paramTypes.length;
  if (requiredCount < 0 || requiredCount > paramTypes.length) {
    throw new Error(`requiredCount must be between 0 and ${paramTypes.length}`);
  }
  return {
    paramTypes,
    requiredCount,
    variadicType: options.variadicType ?? null,
    returnType: options.returnType ?? null,
  };
}

export function callable(returnType: JetType, signatures: CallSignature[]): JetType {
  return TCallable(
    returnType,
    signatures.map((sig) => (sig.returnType !== null ? sig : { ...sig, returnType })),
  );
}

export function paramsToCallSignature(params: Param[]): CallSignature {
  return {
    paramTypes: params.map((p) => (p.typeName ? typeRefToJetTypeOrNull(p.typeName) ?? TUnknown : TUnknown)),
    requiredCount: params.filter((p) => p.default === null).length,
    variadicType: null,
    returnType: null,
  };
}

export function typeRefToJetTypeOrNull(ref: TypeRef): JetType | null {
  switch (ref.name) {
    case "int": return TInt;
    case "float": return TFloat;
    case "string": return TString;
    case "bool": return TBool;
    case "object": return TObject;
    case "null": return TNull;
    case "var": return TUnknown;
    case "list": {
      if (ref.typeArgRef === null) return null;
      const elementType = typeRefToJetTypeOrNull(ref.typeArgRef);
      return elementType === null ? null : TList(elementType);
    }
    default:
      return null;
  }
}

export function typeRefToJetType(ref: TypeRef): JetType {
  return typeRefToJetTypeOrNull(ref) ?? TUnknown;
}
