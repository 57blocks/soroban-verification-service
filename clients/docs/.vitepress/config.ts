import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "Soroban Verifier Docs",
  description:
    "How Soroban contract source verification works, how to submit a contract, and how to read verified results.",
  srcDir: "src",
  outDir: "dist",
  base: "/docs/",
  cleanUrls: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/docs/logo.svg" }]],
  themeConfig: {
    logo: "/logo.svg",
    // Raw, unlike every other link: the console lives outside the /docs/ base.
    logoLink: { link: "/", target: "_self" },
    siteTitle: "Soroban Verifier",
    nav: [{ text: "Introduction", link: "/introduction/what-is-verification", activeMatch: "/introduction/" }],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What is contract verification?", link: "/introduction/what-is-verification" },
          { text: "How it works", link: "/introduction/how-it-works" },
          { text: "Trust model", link: "/introduction/trust-model" },
          { text: "Supported contracts", link: "/introduction/supported-contracts" },
          { text: "Glossary", link: "/introduction/glossary" },
        ],
      },
    ],
    outline: [2, 3],
    search: { provider: "local" },
    footer: {
      message:
        'Apache-2.0 · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Notice</a>',
    },
  },
});
