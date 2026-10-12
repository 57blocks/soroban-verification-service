import { RequestMethod, type INestApplication } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";

export type RouteDeclaration = {
  route: string;
  throttle: string;
  guards?: readonly string[];
  why?: string;
};

export type RouteInventoryOptions = {
  overrideTiers: Readonly<Record<string, number>>;
  adapterLimit: number;
  get: (path: string, caller: string) => Promise<number>;
};

type ServedRoute = { route: string; path: string; source: "controller" | "adapter"; throttle?: string; guards?: string[] };

type ExpressLayer = {
  route?: { path: string; methods: Record<string, boolean> };
  slash?: boolean;
  name?: string;
  match(path: string): boolean;
};

const SKIP = "THROTTLER:SKIPdefault";
const LIMIT = "THROTTLER:LIMITdefault";

const normalise = (path: string): string => `/${path.replace(/^\/+|\/+$/g, "")}`;
const join = (...parts: string[]): string => normalise(parts.filter(Boolean).join("/"));
const concrete = (path: string): string => path.replace(/:[A-Za-z_]\w*/g, "x").replace(/\*\w*/g, "x");
const guardName = (guard: unknown): string =>
  typeof guard === "function" ? guard.name : (guard as object).constructor.name;

function controllerRoutes(app: INestApplication, tiers: Readonly<Record<string, number>>): ServedRoute[] {
  const routes: ServedRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const base = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, controller) ?? "")[0] ?? "";
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const read = (key: string) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
        const limit = read(LIMIT) as number | undefined;
        const tier = Object.entries(tiers).find(([, value]) => value === limit)?.[0];
        const throttle = read(SKIP) ? "skip" : limit === undefined ? "global" : (tier ?? `override(${limit})`);
        const guards = [
          ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
          ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
        ].map(guardName);
        for (const path of ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, handler) ?? "")) {
          const full = join(base, path);
          routes.push({ route: `${RequestMethod[method]} ${full}`, path: full, source: "controller", throttle, guards });
        }
      }
    }
  }
  return routes;
}

function expressLayers(app: INestApplication): ExpressLayer[] {
  const instance = app.getHttpAdapter().getInstance() as { router?: { stack: ExpressLayer[] }; _router?: { stack: ExpressLayer[] } };
  return (instance.router ?? instance._router)?.stack ?? [];
}

/** Every problem found comparing what `app` serves against `declared`; an empty list is a pass. */
export async function routeInventoryProblems(
  app: INestApplication,
  declared: readonly RouteDeclaration[],
  options: RouteInventoryOptions,
): Promise<string[]> {
  const problems: string[] = [];
  const fromControllers = new Map(controllerRoutes(app, options.overrideTiers).map((r) => [r.route, r]));
  const layers = expressLayers(app);

  const served = new Map(fromControllers);
  const anyMethod = new Set([...fromControllers.values()].filter((r) => r.route.startsWith("ALL ")).map((r) => r.path));
  for (const layer of layers) {
    if (!layer.route) continue;
    const path = normalise(layer.route.path);
    if (anyMethod.has(path)) continue;
    for (const method of Object.keys(layer.route.methods).filter((m) => m !== "_all")) {
      const route = `${method.toUpperCase()} ${path}`;
      if (!served.has(route)) served.set(route, { route, path, source: "adapter" });
    }
  }

  const byRoute = new Map(declared.map((d) => [d.route, d]));
  let probes = 0;
  for (const route of served.values()) {
    const declaration = byRoute.get(route.route);
    if (!declaration) {
      problems.push(`${route.route} is served but not declared: add it to this inventory with its throttle tier`);
      continue;
    }
    if (declaration.throttle === "skip" && !declaration.why) {
      problems.push(`${route.route} is declared exempt from throttling without saying why`);
    }
    if (route.source === "controller") {
      if (declaration.throttle !== route.throttle) {
        problems.push(`${route.route} is declared throttle "${declaration.throttle}" but carries "${route.throttle}"`);
      }
      const want = [...(declaration.guards ?? [])].sort().join(",");
      const have = [...(route.guards ?? [])].sort().join(",");
      if (want !== have) problems.push(`${route.route} is declared guards [${want}] but carries [${have}]`);
      continue;
    }
    if (declaration.throttle === "skip") continue;
    if (declaration.throttle !== "adapter") {
      problems.push(`${route.route} is registered on the HTTP adapter, where no guard runs: declare it "adapter" or "skip"`);
      continue;
    }
    probes += 1;
    const caller = `198.18.${Math.floor(probes / 250)}.${probes % 250}`;
    let last = 0;
    for (let i = 0; i <= options.adapterLimit; i++) last = await options.get(concrete(route.path), caller);
    if (last !== 429) {
      problems.push(`${route.route} answered ${last} past its ceiling of ${options.adapterLimit}: no middleware throttles it`);
    }
  }

  for (const declaration of declared) {
    if (!served.has(declaration.route)) problems.push(`${declaration.route} is declared but nothing serves it`);
  }

  const servedPaths = [...served.values()].map((r) => concrete(r.path));
  for (const layer of layers) {
    if (layer.route || layer.slash !== false) continue;
    if (!servedPaths.some((path) => layer.match(path))) {
      problems.push(`middleware "${layer.name}" is mounted at a path no declared route covers: declare the routes it serves`);
    }
  }

  return problems;
}
