import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./custom.css";

export default { extends: DefaultTheme } satisfies Theme;
