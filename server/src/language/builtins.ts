import {
  JetType,
  TBool,
  TFloat,
  TInt,
  TList,
  TNull,
  TObject,
  TString,
  TUnknown,
  callable,
  signature,
} from "./types";

export interface BuiltinTypeProvider {
  globalType(name: string): JetType | null;
  methodType(targetType: JetType, method: string): JetType | null;
  isKnownGlobal(name: string): boolean;
  globalNames(): ReadonlySet<string>;
}

export class DefaultBuiltinTypeProvider implements BuiltinTypeProvider {
  private static readonly GLOBALS: ReadonlyMap<string, () => JetType> = new Map([
    ["typeof", () => callable(TString, [signature([TUnknown])])],
  ]);

  globalType(name: string): JetType | null {
    const factory = DefaultBuiltinTypeProvider.GLOBALS.get(name);
    return factory ? factory() : null;
  }

  globalNames(): ReadonlySet<string> {
    return new Set(DefaultBuiltinTypeProvider.GLOBALS.keys());
  }

  isKnownGlobal(name: string): boolean {
    return DefaultBuiltinTypeProvider.GLOBALS.has(name);
  }

  methodType(targetType: JetType, method: string): JetType | null {
    for (const provider of METHOD_PROVIDERS) {
      const type = provider(targetType, method);
      if (type !== null) return type;
    }
    return null;
  }
}

type MethodProvider = (targetType: JetType, method: string) => JetType | null;

const stringMethods: MethodProvider = (targetType, method) => {
  if (targetType.kind !== "string") return null;
  switch (method) {
    case "length": return callable(TInt, [signature([])]);
    case "contains": return callable(TBool, [signature([TString])]);
    case "replace": return callable(TString, [signature([TString, TString])]);
    case "lower":
    case "upper":
    case "trim": return callable(TString, [signature([])]);
    case "substring": return callable(TString, [signature([TInt, TInt])]);
    case "split": return callable(TList(TString), [signature([TString])]);
    case "indexOf":
      return callable(TInt, [signature([TString]), signature([TString, TInt])]);
    case "lastIndexOf": return callable(TInt, [signature([TString])]);
    case "count": return callable(TInt, [signature([TString])]);
    case "startsWith":
    case "endsWith": return callable(TBool, [signature([TString])]);
    default: return null;
  }
};

const listMethods: MethodProvider = (targetType, method) => {
  if (targetType.kind !== "list") return null;
  const element = targetType.elementType;
  switch (method) {
    case "length": return callable(TInt, [signature([])]);
    case "contains": return callable(TBool, [signature([element])]);
    case "append": return callable(targetType, [signature([element])]);
    case "remove": return callable(targetType, [signature([TInt])]);
    case "ascend":
    case "descend":
    case "reverse": return callable(targetType, [signature([])]);
    case "slice": return callable(targetType, [signature([TInt, TInt])]);
    case "first":
    case "last": return callable(element, [signature([])]);
    case "indexOf":
      return callable(TInt, [signature([element]), signature([element, TInt])]);
    case "lastIndexOf": return callable(TInt, [signature([element])]);
    case "join": return callable(TString, [signature([TString])]);
    default: return null;
  }
};

const objectMethods: MethodProvider = (targetType, method) => {
  if (targetType.kind !== "object") return null;
  switch (method) {
    case "keys": return callable(TList(TString), [signature([])]);
    case "has": return callable(TBool, [signature([TString])]);
    case "length": return callable(TInt, [signature([])]);
    case "remove": return callable(TBool, [signature([TString])]);
    case "set": return callable(TBool, [signature([TString, TUnknown])]);
    case "get": return callable(TUnknown, [signature([TString])]);
    case "append": return callable(TObject, [signature([TObject])]);
    default: return null;
  }
};

const intervalMethods: MethodProvider = (targetType, method) => {
  if (targetType.kind !== "interval") return null;
  switch (method) {
    case "activate":
    case "deactivate":
    case "destroy":
    case "isActive": return callable(TBool, [signature([])]);
    case "trigger": return callable(TNull, [signature([])]);
    default: return null;
  }
};

const listenerMethods: MethodProvider = (targetType, method) => {
  if (targetType.kind !== "listener") return null;
  switch (method) {
    case "activate":
    case "deactivate":
    case "destroy":
    case "isActive": return callable(TBool, [signature([])]);
    case "trigger": return callable(TNull, [signature([]), signature([TUnknown])]);
    default: return null;
  }
};

const commandMethods: MethodProvider = (targetType, method) => {
  if (targetType.kind !== "command") return null;
  switch (method) {
    case "activate":
    case "deactivate":
    case "destroy":
    case "isActive": return callable(TBool, [signature([])]);
    case "trigger":
      return callable(TNull, [signature([], { variadicType: TUnknown })]);
    default: return null;
  }
};

const conversionMethods: MethodProvider = (targetType, method) => {
  switch (targetType.kind) {
    case "int":
      switch (method) {
        case "toFloat": return callable(TFloat, [signature([])]);
        case "toString": return callable(TString, [signature([])]);
        case "toBool": return callable(TBool, [signature([])]);
        default: return null;
      }
    case "float":
      switch (method) {
        case "toInt": return callable(TInt, [signature([])]);
        case "toString": return callable(TString, [signature([])]);
        default: return null;
      }
    case "bool":
      return method === "toInt" ? callable(TInt, [signature([])]) : null;
    case "string":
      switch (method) {
        case "toInt": return callable(TInt, [signature([])]);
        case "toFloat": return callable(TFloat, [signature([])]);
        default: return null;
      }
    default: return null;
  }
};

const METHOD_PROVIDERS: ReadonlyArray<MethodProvider> = [
  stringMethods,
  listMethods,
  objectMethods,
  intervalMethods,
  listenerMethods,
  commandMethods,
  conversionMethods,
];
