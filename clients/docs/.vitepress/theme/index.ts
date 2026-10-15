import DefaultTheme from "vitepress/theme";
import type { EnhanceAppContext, Theme } from "vitepress";
import { defineAsyncComponent } from "vue";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./custom.css";
import LegalOperator from "./LegalOperator.vue";
import ThisOrigin from "./ThisOrigin.vue";

let openapi: Promise<typeof import("vitepress-openapi/client")> | undefined;
const installed = new WeakSet<EnhanceAppContext["app"]>();

/** Loaded on the first API page only: the renderer is about 2 MB, which no other page should pay for. */
const loadOpenapi = async (ctx: EnhanceAppContext) => {
  const module = await (openapi ??= Promise.all([
    import("vitepress-openapi/client"),
    import("vitepress-openapi/dist/style.css"),
  ]).then(([loaded]) => {
    loaded.useTheme({ operation: { hiddenSlots: ["header", "description", "playground", "branding"] } });
    return loaded;
  }));
  // Server rendering builds one app per page, and each needs the renderer's plugins installed.
  if (!installed.has(ctx.app)) {
    installed.add(ctx.app);
    module.theme.enhanceApp(ctx);
  }
  return module;
};

export default {
  extends: DefaultTheme,
  enhanceApp(ctx) {
    ctx.app.component("ThisOrigin", ThisOrigin);
    ctx.app.component("LegalOperator", LegalOperator);
    ctx.app.component(
      "ApiOperation",
      defineAsyncComponent(async () => (await loadOpenapi(ctx)).OAOperation),
    );
  },
} satisfies Theme;
