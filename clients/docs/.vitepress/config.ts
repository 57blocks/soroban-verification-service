import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { API_SPECS, apiSidebar } from "./api-specs.ts";

const RESULT_SCHEMAS = fileURLToPath(new URL("../../../docs/results-sep/schemas", import.meta.url));
const LICENCE_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"];
const repoFile = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url));

const introduction = {
  text: "Introduction",
  items: [
    { text: "What is contract verification?", link: "/" },
    { text: "How it works", link: "/introduction/how-it-works" },
    { text: "Trust model", link: "/introduction/trust-model" },
    { text: "Supported contracts", link: "/introduction/supported-contracts" },
    { text: "Glossary", link: "/introduction/glossary" },
  ],
};

const quickStart = {
  text: "Quick start",
  items: [
    { text: "Submit a contract with curl", link: "/quick-start/submit-with-curl" },
    { text: "Read a result with curl", link: "/quick-start/read-a-result" },
  ],
};

const legalAndResources = [
  {
    text: "Legal",
    items: [
      { text: "Terms and privacy", link: "/legal/terms-and-privacy" },
      { text: "Open-source licenses", link: "/legal/open-source-licenses" },
    ],
  },
  {
    text: "Resources",
    items: [
      { text: "Changelog", link: "/resources/changelog" },
      { text: "Support", link: "/resources/support" },
    ],
  },
];

const apiReference = [
  {
    text: "API reference",
    items: [
      { text: "Overview", link: "/api/" },
      { text: "Progress events", link: "/api/events" },
      { text: "Errors", link: "/api/errors" },
      { text: "Result documents", link: "/api/result-documents" },
    ],
  },
  apiSidebar("submission", "Submission API"),
  apiSidebar("query", "Query API"),
];

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
  buildEnd: ({ outDir }) => {
    cpSync(RESULT_SCHEMAS, join(outDir, "schemas"), { recursive: true });
    mkdirSync(join(outDir, "licenses"), { recursive: true });
    for (const name of LICENCE_FILES) cpSync(repoFile(name), join(outDir, "licenses", `${name}.txt`));
  },
  vite: {
    resolve: {
      alias: { "@openapi/submission": API_SPECS.submission, "@openapi/query": API_SPECS.query },
    },
  },
  themeConfig: {
    logo: "/logo.svg",
    // Raw, unlike every other link: the console lives outside the /docs/ base.
    logoLink: { link: "/", target: "_self" },
    siteTitle: "Soroban Verifier",
    nav: [
      { text: "Introduction", link: "/", activeMatch: "^/($|introduction/)" },
      { text: "Quick start", link: "/quick-start/submit-with-curl", activeMatch: "/quick-start/" },
      { text: "API reference", link: "/api/", activeMatch: "/api/" },
      {
        text: "More",
        activeMatch: "/(legal|resources)/",
        items: [
          { text: "Changelog", link: "/resources/changelog" },
          { text: "Support", link: "/resources/support" },
          { text: "Terms and privacy", link: "/legal/terms-and-privacy" },
          { text: "Open-source licenses", link: "/legal/open-source-licenses" },
        ],
      },
    ],
    sidebar: {
      "/api/": apiReference,
      "/legal/": legalAndResources,
      "/resources/": legalAndResources,
      "/": [introduction, quickStart],
    },
    outline: [2, 3],
    search: { provider: "local" },
    footer: {
      message:
        'Apache-2.0 · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Notice</a>',
    },
  },
});
