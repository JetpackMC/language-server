import {
  CallSignature,
  JetType,
  TBool,
  TFloat,
  TInt,
  TList,
  TNull,
  TNullable,
  TObject,
  TString,
  TUnknown,
  callable,
  signature,
} from "./types";
import { NamedModuleType } from "./moduleGraph";

const NUMERIC_TYPES: JetType[] = [TInt, TFloat];

export const STANDARD_MODULE_TYPES: Map<string, NamedModuleType> = new Map([
  ["math", { dynamic: false, fields: mathFields() }],
  ["json", { dynamic: false, fields: jsonFields() }],
  ["random", { dynamic: false, fields: randomFields() }],
  ["storage", { dynamic: false, fields: storageFields() }],
  ["time", { dynamic: false, fields: timeFields() }],
  ["regex", { dynamic: false, fields: regexFields() }],
  ["bukkit", { dynamic: true, fields: new Map<string, JetType>() }],
  ["plugins", { dynamic: false, fields: pluginsFields() }],
  ["http", { dynamic: false, fields: httpFields() }],
]);

function numericOverloads(arity: number): CallSignature[] {
  const signatures: CallSignature[] = [];
  const build = (params: JetType[]): void => {
    if (params.length === arity) {
      const returnType = params.every((t) => t.kind === "int") ? TInt : TFloat;
      signatures.push(signature(params, { returnType }));
      return;
    }
    for (const type of NUMERIC_TYPES) build([...params, type]);
  };
  build([]);
  return signatures;
}

function numericUnarySignatures(returnType: JetType): CallSignature[] {
  return [signature([TInt], { returnType }), signature([TFloat], { returnType })];
}

function numericBinarySignatures(returnType: JetType): CallSignature[] {
  return [
    signature([TInt, TInt], { returnType }),
    signature([TInt, TFloat], { returnType }),
    signature([TFloat, TInt], { returnType }),
    signature([TFloat, TFloat], { returnType }),
  ];
}

function mathFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["PI", TFloat],
    ["E", TFloat],
    ["LN2", TFloat],
    ["LN10", TFloat],
    ["LOG2E", TFloat],
    ["LOG10E", TFloat],
    ["SQRT1_2", TFloat],
    ["SQRT2", TFloat],
    ["min", callable(TFloat, numericOverloads(2))],
    ["max", callable(TFloat, numericOverloads(2))],
    ["clamp", callable(TFloat, numericOverloads(3))],
    ["sqrt", callable(TFloat, numericUnarySignatures(TFloat))],
    ["abs", callable(TFloat, [
      signature([TInt], { returnType: TInt }),
      signature([TFloat], { returnType: TFloat }),
    ])],
    ["round", callable(TFloat, [
      signature([TInt], { returnType: TInt }),
      signature([TFloat], { returnType: TInt }),
      signature([TInt, TInt], { returnType: TFloat }),
      signature([TFloat, TInt], { returnType: TFloat }),
    ])],
    ["ceil", callable(TInt, numericUnarySignatures(TInt))],
    ["floor", callable(TInt, numericUnarySignatures(TInt))],
    ["sin", callable(TFloat, numericUnarySignatures(TFloat))],
    ["cos", callable(TFloat, numericUnarySignatures(TFloat))],
    ["tan", callable(TFloat, numericUnarySignatures(TFloat))],
    ["asin", callable(TFloat, numericUnarySignatures(TFloat))],
    ["acos", callable(TFloat, numericUnarySignatures(TFloat))],
    ["atan", callable(TFloat, numericUnarySignatures(TFloat))],
    ["atan2", callable(TFloat, numericBinarySignatures(TFloat))],
    ["hypot", callable(TFloat, numericBinarySignatures(TFloat))],
    ["cbrt", callable(TFloat, numericUnarySignatures(TFloat))],
    ["log", callable(TFloat, numericUnarySignatures(TFloat))],
    ["log2", callable(TFloat, numericUnarySignatures(TFloat))],
    ["log10", callable(TFloat, numericUnarySignatures(TFloat))],
    ["exp", callable(TFloat, numericUnarySignatures(TFloat))],
  ]);
}

function jsonFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["parse", callable(TUnknown, [signature([TString])])],
    ["stringify", callable(TString, [signature([TUnknown])])],
    ["valid", callable(TBool, [signature([TString])])],
  ]);
}

function randomFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["decimal", callable(TFloat, [
      signature([]),
      signature([TInt, TInt]),
      signature([TInt, TFloat]),
      signature([TFloat, TInt]),
      signature([TFloat, TFloat]),
    ])],
    ["integer", callable(TInt, [signature([TInt, TInt])])],
    ["select", callable(TUnknown, [signature([TList(TUnknown)])])],
    ["shuffle", callable(TList(TUnknown), [signature([TList(TUnknown)])])],
  ]);
}

function storageFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["create", callable(TBool, [signature([TString])])],
    ["destroy", callable(TBool, [signature([TString])])],
    ["exists", callable(TBool, [signature([TString])])],
    ["has", callable(TBool, [signature([TString, TString])])],
    ["keys", callable(TList(TString), [signature([TString])])],
    ["get", callable(TUnknown, [signature([TString]), signature([TString, TString])])],
    ["set", callable(TBool, [signature([TString, TString, TUnknown])])],
    ["remove", callable(TBool, [signature([TString, TString])])],
    ["clear", callable(TBool, [signature([TString])])],
  ]);
}

function timeFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["now", callable(TObject, [signature([])])],
    ["format", callable(TString, [signature([TObject, TString])])],
    ["parse", callable(TObject, [signature([TString, TString])])],
    ["diff", callable(TObject, [signature([TObject, TObject])])],
    ["delay", callable(TNull, [signature([TInt])])],
  ]);
}

function regexFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["test", callable(TBool, [signature([TString, TString])])],
    ["find", callable(TNullable(TString), [signature([TString, TString])])],
    ["findAll", callable(TList(TString), [signature([TString, TString])])],
    ["groups", callable(TList(TUnknown), [signature([TString, TString])])],
    ["replace", callable(TString, [signature([TString, TString, TString])])],
    ["replaceAll", callable(TString, [signature([TString, TString, TString])])],
    ["split", callable(TList(TString), [signature([TString, TString])])],
    ["escape", callable(TString, [signature([TString])])],
  ]);
}

function pluginsFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["get", callable(TNullable(TUnknown), [signature([TString])])],
    ["enabled", callable(TBool, [signature([TString])])],
    ["type", callable(TUnknown, [signature([TString, TString])])],
  ]);
}

function httpFields(): Map<string, JetType> {
  return new Map<string, JetType>([
    ["get", callable(TObject, [signature([TString, TObject], { requiredCount: 1 })])],
    ["post", callable(TObject, [signature([TString, TObject, TObject], { requiredCount: 2 })])],
    ["put", callable(TObject, [signature([TString, TObject, TObject], { requiredCount: 2 })])],
    ["delete", callable(TObject, [signature([TString, TObject], { requiredCount: 1 })])],
  ]);
}
