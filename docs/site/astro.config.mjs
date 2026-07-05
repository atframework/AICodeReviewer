// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// AICodeReviewer documentation site.
//
// Routing strategy: every locale is URL-prefixed for a symmetric structure.
//   English  -> /en/...
//   简体中文  -> /zh-cn/...
// `defaultLocale: "en"` only controls UI-string fallback and language detection,
// it does NOT make English a root (non-prefixed) locale.
//
// Deployment target: GitHub Pages project page at
//   https://owent.github.io/AICodeReviewer/
// `site` is the host origin only (no repo name); `base` is the repo path with
// leading and no trailing slash. Change both when moving to a custom domain
// (set `site` to the domain and remove `base`, then add a public/CNAME file).

export default defineConfig({
  site: "https://owent.github.io",
  base: "/AICodeReviewer/",
  integrations: [
    starlight({
      title: "AICodeReviewer",
      defaultLocale: "en",
      locales: {
        en: {
          label: "English",
          lang: "en",
        },
        "zh-cn": {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      sidebar: [
        {
          label: "Getting Started",
          translations: { "zh-CN": "快速上手" },
          items: [
            { slug: "start/quick-start", translations: { "zh-CN": "快速上手" } },
            { slug: "start/docker-compose", translations: { "zh-CN": "Docker Compose 部署" } },
            { slug: "start/first-webhook", translations: { "zh-CN": "第一个 Webhook 评审" } },
            { slug: "start/dry-run", translations: { "zh-CN": "Dry-run 评审" } },
            { slug: "start/dashboard", translations: { "zh-CN": "Dashboard 与日志" } },
          ],
        },
        {
          label: "Configuration",
          translations: { "zh-CN": "配置" },
          items: [
            { slug: "configuration/overview", translations: { "zh-CN": "配置总览" } },
            { slug: "configuration/authentication", translations: { "zh-CN": "认证与密钥" } },
            { slug: "configuration/llm", translations: { "zh-CN": "LLM 提供商与模型" } },
            { slug: "configuration/agent", translations: { "zh-CN": "Agent 与沙箱" } },
            { slug: "configuration/outputs", translations: { "zh-CN": "输出通道与路由" } },
            { slug: "configuration/storage", translations: { "zh-CN": "存储" } },
            { slug: "configuration/queue", translations: { "zh-CN": "队列与重试" } },
          ],
        },
        {
          label: "Deployment",
          translations: { "zh-CN": "部署" },
          items: [
            { slug: "deployment/docker", translations: { "zh-CN": "Docker 部署" } },
            { slug: "deployment/podman", translations: { "zh-CN": "Podman / Rootless" } },
            { slug: "deployment/operations", translations: { "zh-CN": "运维与安全" } },
          ],
        },
        {
          label: "Integrations",
          translations: { "zh-CN": "集成" },
          items: [
            { slug: "integrations/vcs-providers", translations: { "zh-CN": "VCS 提供商" } },
            { slug: "integrations/agent-adapters", translations: { "zh-CN": "Agent 适配器" } },
            { slug: "integrations/output-channels", translations: { "zh-CN": "输出通道" } },
            { slug: "integrations/mcp-tools", translations: { "zh-CN": "MCP 工具" } },
          ],
        },
        {
          label: "Reference",
          translations: { "zh-CN": "参考" },
          items: [
            { slug: "reference/cli", translations: { "zh-CN": "CLI 命令" } },
            { slug: "reference/config-fields", translations: { "zh-CN": "配置字段参考" } },
            { slug: "reference/template-variables", translations: { "zh-CN": "模板变量" } },
          ],
        },
        {
          label: "Troubleshooting",
          translations: { "zh-CN": "排障" },
          items: [
            { slug: "troubleshooting", translations: { "zh-CN": "常见问题" } },
          ],
        },
        {
          label: "Development",
          translations: { "zh-CN": "开发" },
          items: [
            { slug: "development", translations: { "zh-CN": "贡献指南" } },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
      // Starlight >= 0.33 expects `social` as an array of link items.
      social: [
        {
          label: "GitHub",
          icon: "github",
          href: "https://github.com/atframework/AICodeReviewer",
        },
      ],
    }),
  ],
});
