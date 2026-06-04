import { Statement, Using } from "./ast";
import { JetType, TModule, TUnknown } from "./types";
import { ModuleTreeNode, ScriptModule, displayPath, isVisibleInModule } from "./module";
import { resolveUsingPath, usingDisplayPath, UsingError } from "./usingResolver";
import { NameResolver } from "./resolver";
import { TypeChecker } from "./checker";
import { BuiltinTypeProvider } from "./builtins";

export interface AnalysisError {
  uri: string;
  message: string;
  line: number;
  prevLine?: number;
}

export interface NamedModuleType {
  fields: Map<string, JetType>;
  dynamic: boolean;
}

export interface ModuleGraphDeps {
  namedModuleTypes: Map<string, NamedModuleType>;
  builtinGlobalNames: ReadonlySet<string>;
  typeProvider: BuiltinTypeProvider | null;
  isKnownEvent: (name: string) => boolean;
}

interface ImportPlan {
  roots: Map<string, ModuleTreeNode>;
  aliases: Map<string, ScriptModule>;
}

export class ModuleGraph {
  private readonly byLogicalPath = new Map<string, ScriptModule>();
  private readonly byCanonicalPath = new Map<string, ScriptModule>();
  private readonly errors: AnalysisError[] = [];

  constructor(
    private readonly modules: ScriptModule[],
    private readonly deps: ModuleGraphDeps,
  ) {
    for (const module of modules) {
      this.byCanonicalPath.set(module.uri, module);
      this.byLogicalPath.set(displayPath(module), module);
    }
  }

  analyze(): AnalysisError[] {
    this.errors.length = 0;
    for (const module of this.modules) {
      module.resolvedImports = [];
      module.validationState = null;
    }
    for (const module of this.modules) this.resolveImports(module);
    for (const module of this.modules) this.validateModule(module, []);
    return [...this.errors];
  }

  private resolveImports(module: ScriptModule): void {
    if (module.validationState === false) return;
    const resolved: { using: Using; targetModules: ScriptModule[] }[] = [];
    let ok = true;
    for (const stmt of usingStatements(module.stmts)) {
      let targets: ScriptModule[];
      try {
        targets = this.resolveImportTargets(module, stmt);
      } catch (e) {
        if (e instanceof UsingError) {
          this.report(module, e.message, e.line);
          ok = false;
          targets = [];
        } else {
          throw e;
        }
      }
      if (targets.length > 0) {
        resolved.push({ using: stmt, targetModules: distinctByUri(targets) });
      }
    }
    module.resolvedImports = resolved;
    if (!ok) module.validationState = false;
  }

  private validateModule(module: ScriptModule, stack: ScriptModule[]): boolean {
    if (module.validationState !== null) return module.validationState;
    if (stack.includes(module)) {
      const cycle = [...dropWhile(stack, (m) => m !== module), module];
      const cyclePath = cycle.map((m) => displayPath(m)).join(" -> ");
      this.report(module, `Circular import detected: ${cyclePath}`, 0);
      return false;
    }

    stack.push(module);
    let ok = true;

    for (const resolved of module.resolvedImports) {
      for (const dependency of resolved.targetModules) {
        ok = this.validateModule(dependency, stack) && ok;
      }
    }

    if (ok) {
      let importTypes: Map<string, JetType>;
      try {
        importTypes = this.buildImportTypeBindings(module);
      } catch (e) {
        if (e instanceof UsingError) {
          this.report(module, e.message, e.line);
          ok = false;
          importTypes = new Map();
        } else {
          throw e;
        }
      }

      if (ok) {
        const predefinedNames = new Set(importTypes.keys());
        const reservedNames = new Set([...predefinedNames, ...this.deps.builtinGlobalNames]);
        const resolverErrors = new NameResolver(reservedNames, this.deps.isKnownEvent).resolve(
          module.stmts,
          predefinedNames,
        );
        for (const err of resolverErrors) {
          this.report(module, err.message, err.line, err.prevLine);
        }

        let typeErrorCount = 0;
        if (resolverErrors.length === 0) {
          const typeErrors = new TypeChecker(this.deps.typeProvider).check(module.stmts, importTypes);
          for (const err of typeErrors) this.report(module, err.message, err.line);
          typeErrorCount = typeErrors.length;
        }
        ok = resolverErrors.length === 0 && typeErrorCount === 0;
      }
    }

    stack.pop();
    module.validationState = ok;
    return ok;
  }

  private resolveImportTargets(module: ScriptModule, stmt: Using): ScriptModule[] {
    if (this.isRegisteredModuleUsing(stmt)) return [];
    const pathSegments = resolveUsingPath(stmt, module.pathSegments);
    if (stmt.recursive) {
      const matches = [...this.byCanonicalPath.values()]
        .filter((m) => startsWithPrefix(m.pathSegments, pathSegments))
        .sort((a, b) => displayPath(a).localeCompare(displayPath(b)));
      if (matches.length === 0) {
        throw new UsingError(`Using target '${usingDisplayPath(stmt)}' does not exist`, stmt.line);
      }
      return matches;
    }
    const key = pathSegments.join(".");
    const target = this.byLogicalPath.get(key);
    if (target === undefined) {
      throw new UsingError(`Using target '${usingDisplayPath(stmt)}' does not exist`, stmt.line);
    }
    return [target];
  }

  private buildImportTypeBindings(module: ScriptModule): Map<string, JetType> {
    const plan = this.buildImportPlan(module);
    const bindings = new Map<string, JetType>();

    for (const [alias, targetModule] of plan.aliases) {
      const node = new ModuleTreeNode();
      node.module = targetModule;
      bindings.set(alias, this.buildModuleType(node, alias, this.aliasLine(module, alias)));
    }

    for (const [rootName, node] of plan.roots) {
      bindings.set(rootName, this.buildModuleType(node, rootName, 0));
    }

    this.bindRegisteredModuleTypes(module, bindings);
    return bindings;
  }

  private aliasLine(module: ScriptModule, alias: string): number {
    return module.resolvedImports.find((r) => r.using.alias === alias)?.using.line ?? 0;
  }

  private isRegisteredModuleUsing(stmt: Using): boolean {
    if (stmt.relativeDots !== 0 || stmt.recursive || stmt.path.length === 0) return false;
    const registration = this.deps.namedModuleTypes.get(stmt.path[0]);
    if (registration === undefined) return false;
    return stmt.path.length === 1 || registration.dynamic;
  }

  private bindRegisteredModuleTypes(module: ScriptModule, bindings: Map<string, JetType>): void {
    for (const stmt of usingStatements(module.stmts)) {
      if (!this.isRegisteredModuleUsing(stmt)) continue;
      const rootName = stmt.path[0];
      const registration = this.deps.namedModuleTypes.get(rootName);
      if (registration === undefined) continue;
      const alias = stmt.alias ?? rootName;
      if (bindings.has(alias)) {
        if (stmt.alias === null && alias === rootName) continue;
        throw new UsingError(`Module '${alias}' is already declared`, stmt.line);
      }
      bindings.set(alias, registration.dynamic ? TUnknown : TModule(registration.fields));
    }
  }

  private buildImportPlan(module: ScriptModule): ImportPlan {
    const roots = new Map<string, ModuleTreeNode>();
    const aliases = new Map<string, ScriptModule>();
    const reservedNames = this.deps.builtinGlobalNames;

    for (const resolved of module.resolvedImports) {
      if (resolved.targetModules.length === 0) continue;
      const alias = resolved.using.alias;
      if (alias !== null) {
        if (reservedNames.has(alias)) {
          throw new UsingError(`Module '${alias}' collides with a built-in name`, resolved.using.line);
        }
        if (aliases.has(alias) || roots.has(alias)) {
          throw new UsingError(`Module '${alias}' is already declared`, resolved.using.line);
        }
        aliases.set(alias, single(resolved.targetModules));
        continue;
      }
      for (const targetModule of resolved.targetModules) {
        addToModuleTree(roots, targetModule);
      }
    }

    for (const rootName of roots.keys()) {
      const usingLine =
        module.resolvedImports.find(
          (resolved) =>
            resolved.using.alias === null &&
            resolved.targetModules.some((m) => m.pathSegments[0] === rootName),
        )?.using.line ?? 0;
      if (reservedNames.has(rootName)) {
        throw new UsingError(`Module '${rootName}' collides with a built-in name`, usingLine);
      }
      if (aliases.has(rootName)) {
        throw new UsingError(`Module '${rootName}' is already declared`, usingLine);
      }
    }

    return { roots, aliases };
  }

  private buildModuleType(node: ModuleTreeNode, modulePath: string, line: number): JetType {
    const fields = new Map<string, JetType>();
    const moduleRef = node.module;
    if (moduleRef !== null) {
      for (const definition of moduleRef.exportDefinitions.values()) {
        if (!isVisibleInModule(definition)) continue;
        if (node.children.has(definition.name)) {
          throw new UsingError(`Module member collision at '${modulePath}.${definition.name}'`, line);
        }
        fields.set(definition.name, definition.type);
      }
    }
    for (const [childName, childNode] of node.children) {
      if (fields.has(childName)) {
        throw new UsingError(`Module member collision at '${modulePath}.${childName}'`, line);
      }
      fields.set(childName, this.buildModuleType(childNode, `${modulePath}.${childName}`, line));
    }
    return TModule(fields);
  }

  private report(module: ScriptModule, message: string, line: number, prevLine?: number): void {
    this.errors.push({ uri: module.uri, message, line, prevLine });
  }
}

function usingStatements(stmts: Statement[]): Using[] {
  return stmts.filter((s): s is Using => s.kind === "Using");
}

function addToModuleTree(roots: Map<string, ModuleTreeNode>, module: ScriptModule): void {
  const [first, ...rest] = module.pathSegments;
  let current = getOrPut(roots, first);
  for (const segment of rest) {
    current = getOrPut(current.children, segment);
  }
  current.module = module;
}

function getOrPut(map: Map<string, ModuleTreeNode>, key: string): ModuleTreeNode {
  let node = map.get(key);
  if (node === undefined) {
    node = new ModuleTreeNode();
    map.set(key, node);
  }
  return node;
}

function startsWithPrefix(segments: string[], prefix: string[]): boolean {
  if (prefix.length > segments.length) return false;
  return prefix.every((p, i) => segments[i] === p);
}

function distinctByUri(modules: ScriptModule[]): ScriptModule[] {
  const seen = new Set<string>();
  const result: ScriptModule[] = [];
  for (const module of modules) {
    if (!seen.has(module.uri)) {
      seen.add(module.uri);
      result.push(module);
    }
  }
  return result;
}

function dropWhile<T>(items: T[], predicate: (item: T) => boolean): T[] {
  let i = 0;
  while (i < items.length && predicate(items[i])) i++;
  return items.slice(i);
}

function single<T>(items: T[]): T {
  if (items.length !== 1) {
    throw new Error(`Expected exactly one element but found ${items.length}`);
  }
  return items[0];
}
