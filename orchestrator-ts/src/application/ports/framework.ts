import type { FrameworkDefinition } from "@/domain/workflow/framework";

export interface FrameworkDefinitionPort {
  /**
   * Load the framework definition for the given identifier.
   * Throws when no matching definition is found, with a message listing available frameworks.
   */
  load(frameworkId: string): Promise<FrameworkDefinition>;
}
