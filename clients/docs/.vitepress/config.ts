import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { sourceIsPublic } from "../../web/src/config/site.ts";
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

/** Running a verifier needs the source, so these pages are built only once it is public. */
const showUnreleased = sourceIsPublic || Boolean(process.env.SCVS_DOCS_SHOW_UNRELEASED);

const selfHosting = {
  text: "Run your own verifier",
  items: [
    { text: "Configuration reference", link: "/self-hosting/configuration" },
  ],
};

const quickStart = {
  text: "Quick start",
  items: [
    { text: "Verify in the console", link: "/quick-start/verify-in-the-console" },
    { text: "Submit a contract with curl", link: "/quick-start/submit-with-curl" },
    { text: "Read a result with curl", link: "/quick-start/read-a-result" },
  ],
};

const guides = [
  {
    text: "For contract developers",
    items: [
      { text: "Make your contract verifiable", link: "/developers/make-your-contract-verifiable" },
      { text: "Prepare your source", link: "/developers/prepare-your-source" },
      { text: "Use the console", link: "/developers/use-the-console" },
      { text: "Understand a result", link: "/developers/understand-a-result" },
      { text: "Troubleshoot a failed verification", link: "/developers/troubleshoot" },
      { text: "Verify from CI", link: "/developers/verify-from-ci" },
    ],
  },
  {
    text: "For integrators",
    items: [
      { text: "Choose an interface", link: "/integrators/choose-an-interface" },
      { text: "Query across verifiers", link: "/integrators/query-across-verifiers" },
      { text: "Interpret multi-verifier results", link: "/integrators/interpret-multi-verifier-results" },
      { text: "Read the result tree directly", link: "/integrators/read-the-result-tree" },
    ],
  },
];

const legalAndResources = [
  {
    text: "Security",
    items: [
      { text: "Security model", link: "/security/security-model" },
      { text: "Report a vulnerability", link: "/security/report-a-vulnerability" },
    ],
  },
  {
    text: "Legal",
    items: [
      { text: "Terms and privacy", link: "/legal/terms-and-privacy" },
      { text: "Data and retention", link: "/legal/data-and-retention" },
      { text: "Open-source licenses", link: "/legal/open-source-licenses" },
    ],
  },
  {
    text: "Resources",
    items: [
      { text: "FAQ", link: "/resources/faq" },
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
  srcExclude: showUnreleased ? [] : ["self-hosting/**", "specifications/**"],
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
      { text: "Quick start", link: "/quick-start/verify-in-the-console", activeMatch: "/quick-start/" },
      { text: "Guides", link: "/developers/make-your-contract-verifiable", activeMatch: "/(developers|integrators)/" },
      { text: "API reference", link: "/api/", activeMatch: "/api/" },
      {
        text: "More",
        activeMatch: "/(legal|resources|security)/",
        items: [
          { text: "FAQ", link: "/resources/faq" },
          { text: "Security model", link: "/security/security-model" },
          { text: "Report a vulnerability", link: "/security/report-a-vulnerability" },
          { text: "Changelog", link: "/resources/changelog" },
          { text: "Support", link: "/resources/support" },
          { text: "Terms and privacy", link: "/legal/terms-and-privacy" },
          { text: "Data and retention", link: "/legal/data-and-retention" },
          { text: "Open-source licenses", link: "/legal/open-source-licenses" },
        ],
      },
    ],
    sidebar: {
      "/developers/": guides,
      "/integrators/": guides,
      "/api/": apiReference,
      ...(showUnreleased ? { "/self-hosting/": [selfHosting] } : {}),
      "/legal/": legalAndResources,
      "/security/": legalAndResources,
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
