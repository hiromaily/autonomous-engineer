import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "Autonomous Engineer",
    description:
      "Documentation for the Autonomous Engineer system — AI-driven spec-driven development.",
    base: "/autonomous-engineer/",

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
            { text: "Spec Plan", link: "/specs" },
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
          ],
        },
        {
          text: "Memory",
          items: [
            {
              text: "Memory Architecture",
              link: "/memory/memory-architecture",
            },
          ],
        },
        {
          text: "Development",
          items: [
            {
              text: "Development Environment",
              link: "/development/development-environment",
            },
            {
              text: "AI Agent Framework Policy",
              link: "/development/ai-agent-framework-policy",
            },
          ],
        },
      ],

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
