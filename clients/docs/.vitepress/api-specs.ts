import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DefaultTheme } from "vitepress";

const METHODS = ["get", "put", "post", "delete", "patch"] as const;

type Operation = { operationId: string; summary?: string; description?: string; tags?: string[]; deprecated?: boolean };
type OpenApiDocument = { paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>> };

export const API_SPECS = {
  submission: fileURLToPath(new URL("../../../services/verification-svc/openapi.json", import.meta.url)),
  query: fileURLToPath(new URL("../../../services/query-svc/openapi.json", import.meta.url)),
} as const;

export type ApiName = keyof typeof API_SPECS;

export type PublicOperation = Operation & { method: string; path: string };

export const slugOf = (operationId: string) => operationId.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const load = (api: ApiName): OpenApiDocument => {
  try {
    return JSON.parse(readFileSync(API_SPECS[api], "utf8")) as OpenApiDocument;
  } catch (error) {
    throw new Error(`${API_SPECS[api]} is unreadable — run \`pnpm run generate:openapi\` first`, { cause: error });
  }
};

/** Routes under /api/ only: the bare /health routes answer the load balancer, not the public. */
export const publicOperations = (api: ApiName): PublicOperation[] =>
  Object.entries(load(api).paths)
    .filter(([path]) => path.startsWith("/api/"))
    .flatMap(([path, item]) =>
      METHODS.flatMap((method) => (item[method] ? [{ ...item[method]!, method: method.toUpperCase(), path }] : [])),
    )
    .filter((operation) => !operation.deprecated);

export const apiSidebar = (api: ApiName, title: string): DefaultTheme.SidebarItem => {
  const groups = new Map<string, DefaultTheme.SidebarItem[]>();
  for (const operation of publicOperations(api)) {
    const tag = operation.tags?.[0] ?? "Other";
    groups.set(tag, [
      ...(groups.get(tag) ?? []),
      { text: operation.summary ?? `${operation.method} ${operation.path}`, link: `/api/${api}/${slugOf(operation.operationId)}` },
    ]);
  }
  return {
    text: title,
    collapsed: false,
    items: [...groups].map(([text, items]) => ({ text, collapsed: false, items })),
  };
};
