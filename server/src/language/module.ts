import { AccessModifier, Statement, Using } from "./ast";
import {
  JetType,
  TCallable,
  TCommand,
  TInterval,
  TListener,
  TUnknown,
  paramsToCallSignature,
  typeRefToJetType,
} from "./types";

export interface ModuleExportDefinition {
  name: string;
  access: AccessModifier;
  type: JetType;
  isReadOnly: boolean;
  availableAfterDeclaration: boolean;
}

export function isVisibleInModule(def: ModuleExportDefinition): boolean {
  return def.access !== "private";
}

export interface ResolvedImport {
  using: Using;
  targetModules: ScriptModule[];
}

export interface ScriptModule {
  uri: string;
  pathSegments: string[];
  stmts: Statement[];
  sourceLines: string[];
  exportDefinitions: Map<string, ModuleExportDefinition>;
  resolvedImports: ResolvedImport[];
  validationState: boolean | null;
}

export class ModuleTreeNode {
  readonly children = new Map<string, ModuleTreeNode>();
  module: ScriptModule | null = null;
}

export function displayPath(module: ScriptModule): string {
  return module.pathSegments.join(".");
}

export function collectExportDefinitions(stmts: Statement[]): Map<string, ModuleExportDefinition> {
  const exports = new Map<string, ModuleExportDefinition>();
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "VarDecl":
        exports.set(stmt.name, {
          name: stmt.name,
          access: stmt.access,
          type: typeRefToJetType(stmt.typeName),
          isReadOnly: stmt.isConst || stmt.access === "protected",
          availableAfterDeclaration: false,
        });
        break;
      case "FunctionDecl":
        exports.set(stmt.name, {
          name: stmt.name,
          access: stmt.access,
          type: TCallable(
            stmt.returnType ? typeRefToJetType(stmt.returnType) : TUnknown,
            [paramsToCallSignature(stmt.params)],
          ),
          isReadOnly: true,
          availableAfterDeclaration: true,
        });
        break;
      case "IntervalDecl":
        exports.set(stmt.name, {
          name: stmt.name,
          access: stmt.access,
          type: TInterval,
          isReadOnly: true,
          availableAfterDeclaration: true,
        });
        break;
      case "ListenerDecl":
        exports.set(stmt.name, {
          name: stmt.name,
          access: stmt.access,
          type: TListener,
          isReadOnly: true,
          availableAfterDeclaration: true,
        });
        break;
      case "CommandDecl":
        exports.set(stmt.name, {
          name: stmt.name,
          access: stmt.access,
          type: TCommand,
          isReadOnly: true,
          availableAfterDeclaration: true,
        });
        break;
      case "Deconstruction":
        if (stmt.isDeclaration) {
          for (const binding of stmt.bindings) {
            if (binding.name === null) continue;
            exports.set(binding.name, {
              name: binding.name,
              access: stmt.access,
              type: binding.typeName ? typeRefToJetType(binding.typeName) : TUnknown,
              isReadOnly: stmt.isConst || stmt.access === "protected",
              availableAfterDeclaration: false,
            });
          }
        }
        break;
      default:
        break;
    }
  }
  return exports;
}
