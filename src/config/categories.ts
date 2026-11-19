/**
 * Categories after configuration merges over the built-ins, and the label
 * rules the classifier receives.
 */
import { DEFAULT_LABEL_RULES, type LabelRule } from "../core/classify/rules";
import { compileLabel } from "../core/util/regex";
import { BUILTIN_CATEGORY_DEFINITIONS, type CategoryDefinition } from "./defaults";

/** A configured category entry; fields left out keep the built-in values. */
export interface CategoryOverride {
  id: string;
  title?: string;
  labels?: string[];
  conventionalTypes?: string[];
  internal?: boolean;
}

function titleFromId(id: string): string {
  const words = id.split("-").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Merges configured categories over the built-ins by id. New ids follow the
 * built-ins in configuration order.
 *
 * @param overrides - Configured categories
 * @returns Every category with all fields set
 */
export function resolveCategories(overrides: readonly CategoryOverride[]): CategoryDefinition[] {
  const resolved = BUILTIN_CATEGORY_DEFINITIONS.map((c) => ({ ...c }));
  for (const o of overrides) {
    const existing = resolved.find((c) => c.id === o.id);
    if (existing) {
      existing.title = o.title ?? existing.title;
      existing.labels = o.labels ?? existing.labels;
      existing.conventionalTypes = o.conventionalTypes ?? existing.conventionalTypes;
      existing.internal = o.internal ?? existing.internal;
    } else {
      resolved.push({
        id: o.id,
        title: o.title ?? titleFromId(o.id),
        labels: o.labels ?? [],
        conventionalTypes: o.conventionalTypes ?? [],
        internal: o.internal ?? false,
      });
    }
  }
  return resolved;
}

/**
 * Label rules for the classifier: configured labels first, then the hosted
 * label map with its category titles renamed to match the resolved titles.
 *
 * @param categories - Resolved categories
 * @returns Rules in priority order
 * @throws SyntaxError when a `/regex/` label does not compile
 */
export function buildLabelRules(categories: readonly CategoryDefinition[]): LabelRule[] {
  const configured = categories.flatMap((c) =>
    c.labels.map((label) => ({ pattern: compileLabel(label), category: c.title }))
  );
  const renamed = new Map(
    BUILTIN_CATEGORY_DEFINITIONS.map((b) => [
      b.title,
      categories.find((c) => c.id === b.id)?.title ?? b.title,
    ])
  );
  const base = DEFAULT_LABEL_RULES.map((rule) => ({
    pattern: rule.pattern,
    category: renamed.get(rule.category) ?? rule.category,
  }));
  return [...configured, ...base];
}
