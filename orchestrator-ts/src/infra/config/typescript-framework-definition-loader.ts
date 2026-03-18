import type { FrameworkDefinitionPort } from "@/application/ports/framework";
import { type FrameworkDefinition, validateFrameworkDefinition } from "@/domain/workflow/framework";
import { CC_SDD_FRAMEWORK_DEFINITION } from "@/infra/sdd/cc-sdd-framework-definition";

const ALL_DEFINITIONS: readonly FrameworkDefinition[] = [CC_SDD_FRAMEWORK_DEFINITION];

/**
 * Loads framework definitions from a static in-process registry.
 * Definitions are validated once at construction time.
 */
export class TypeScriptFrameworkDefinitionLoader implements FrameworkDefinitionPort {
  private readonly registry: Map<string, FrameworkDefinition>;

  constructor() {
    this.registry = new Map();
    for (const def of ALL_DEFINITIONS) {
      validateFrameworkDefinition(def);
      this.registry.set(def.id, def);
    }
  }

  async load(frameworkId: string): Promise<FrameworkDefinition> {
    const def = this.registry.get(frameworkId);
    if (!def) {
      const available = [...this.registry.keys()].join(", ");
      throw new Error(
        `Unknown framework identifier: "${frameworkId}". Available frameworks: ${available}`,
      );
    }
    return def;
  }
}
