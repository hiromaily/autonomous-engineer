import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "Autonomous Engineer",
    description:
      "Documentation for the Autonomous Engineer system — AI-driven spec-driven development.",
    base: "/autonomous-engineer/",

    locales: {
      root: {
        label: "English",
        lang: "en",
        themeConfig: {
          nav: [
            { text: "Home", link: "/" },
            { text: "Vision", link: "/vision" },
            { text: "Specs", link: "/specs" },
          ],
          sidebar: [
            {
              text: "Overview",
              items: [
                { text: "Introduction", link: "/vision" },
                { text: "System Overview", link: "/system-overview" },
              ],
            },
            {
              text: "Architecture",
              collapsed: false,
              items: [
                { text: "Architecture", link: "/architecture/architecture" },
                {
                  text: "Agent Loop",
                  link: "/architecture/agent-loop-architecture",
                },
                {
                  text: "Tool System",
                  link: "/architecture/tool-system-architecture",
                },
                {
                  text: "Context Engineering",
                  link: "/architecture/context-engineering-architecture",
                },
                {
                  text: "Task Planning",
                  link: "/architecture/task-planning-architecture",
                },
                {
                  text: "Agent Safety",
                  link: "/architecture/agent-safety-architecture",
                },
                {
                  text: "Codebase Intelligence",
                  link: "/architecture/codebase-intelligence-architecture",
                },
                {
                  text: "Memory Architecture",
                  link: "/memory/memory-architecture",
                },
              ],
            },
            {
              text: "Agent",
              items: [{ text: "AI Dev Agent v1", link: "/agent/dev-agent-v1" }],
            },
            {
              text: "Workflow",
              items: [
                {
                  text: "Spec-Driven Workflow",
                  link: "/workflow/spec-driven-workflow",
                },
                {
                  text: "Automation Workflow",
                  link: "/workflow/automation-workflow",
                },
              ],
            },
            {
              text: "Frameworks",
              items: [
                { text: "Overview", link: "/frameworks/" },
                { text: "cc-sdd", link: "/frameworks/cc-sdd" },
                { text: "OpenSpec", link: "/frameworks/openspec" },
              ],
            },
            {
              text: "Development",
              items: [
                { text: "Spec Plan", link: "/agent/dev-agent-v1-specs" },
                {
                  text: "Development Environment",
                  link: "/development/development-environment",
                },
                {
                  text: "AI Agent Framework Policy",
                  link: "/development/ai-agent-framework-policy",
                },
                {
                  text: "Agent Configuration",
                  link: "/development/agent-configuration",
                },
              ],
            },
          ],
        },
      },
      ja: {
        label: "日本語",
        lang: "ja",
        link: "/ja/",
        themeConfig: {
          nav: [
            { text: "ホーム", link: "/ja/" },
            { text: "ビジョン", link: "/ja/vision" },
            { text: "仕様", link: "/ja/specs" },
          ],
          sidebar: [
            {
              text: "概要",
              items: [
                { text: "はじめに", link: "/ja/vision" },
                { text: "システム概要", link: "/ja/system-overview" },
              ],
            },
            {
              text: "アーキテクチャ",
              collapsed: false,
              items: [
                { text: "アーキテクチャ", link: "/ja/architecture/architecture" },
                {
                  text: "エージェントループ",
                  link: "/ja/architecture/agent-loop-architecture",
                },
                {
                  text: "ツールシステム",
                  link: "/ja/architecture/tool-system-architecture",
                },
                {
                  text: "コンテキストエンジニアリング",
                  link: "/ja/architecture/context-engineering-architecture",
                },
                {
                  text: "タスク計画",
                  link: "/ja/architecture/task-planning-architecture",
                },
                {
                  text: "エージェント安全性",
                  link: "/ja/architecture/agent-safety-architecture",
                },
                {
                  text: "コードベース解析",
                  link: "/ja/architecture/codebase-intelligence-architecture",
                },
                {
                  text: "メモリアーキテクチャ",
                  link: "/ja/memory/memory-architecture",
                },
              ],
            },
            {
              text: "エージェント",
              items: [{ text: "AI Dev Agent v1", link: "/ja/agent/dev-agent-v1" }],
            },
            {
              text: "ワークフロー",
              items: [
                {
                  text: "仕様駆動ワークフロー",
                  link: "/ja/workflow/spec-driven-workflow",
                },
                {
                  text: "自動化ワークフロー",
                  link: "/ja/workflow/automation-workflow",
                },
              ],
            },
            {
              text: "フレームワーク",
              items: [
                { text: "概要", link: "/ja/frameworks/" },
                { text: "cc-sdd", link: "/ja/frameworks/cc-sdd" },
                { text: "OpenSpec", link: "/ja/frameworks/openspec" },
              ],
            },
            {
              text: "開発",
              items: [
                { text: "仕様計画", link: "/ja/agent/dev-agent-v1-specs" },
                {
                  text: "開発環境",
                  link: "/ja/development/development-environment",
                },
                {
                  text: "AIエージェントフレームワークポリシー",
                  link: "/ja/development/ai-agent-framework-policy",
                },
                {
                  text: "エージェント設定",
                  link: "/ja/development/agent-configuration",
                },
              ],
            },
          ],
        },
      },
    },

    themeConfig: {
      socialLinks: [
        {
          icon: "github",
          link: "https://github.com/hiromaily/autonomous-engineer",
        },
      ],

      search: {
        provider: "local",
      },

      footer: {
        message: "Autonomous Engineer Documentation",
      },
    },

    mermaid: {},
  })
);
