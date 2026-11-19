/**
 * Curated entry point of the ReleaseRay core.
 *
 * Exports are listed one by one, never with `export *`, so nothing reaches the
 * Action bundle by accident (CONVERSION-PLAN §6.1).
 */
export { configureLogger, createLogger, consoleSink, resetLogger } from "./logger";
export type { LogContext, LogLevel, LogRecord, LogSink, LoggerConfig } from "./logger";

export {
  BUILTIN_CATEGORIES,
  ClassifiedItemSchema,
  createGroupedChangesSchema,
  DraftOutputSchema,
  GroupedChangesSchema,
  SectionConfigSchema,
} from "./types";
export type {
  ClassifiedItem,
  DraftOutput,
  GroupedChanges,
  PersonaSectionDefaults,
  PersonaVisibility,
  ResolvedPersona,
  SectionConfig,
  ToneSliders,
} from "./types";

export {
  buildPersonaPrompt,
  findUnknownPlaceholders,
  formatUntrustedInput,
  GENERATION_THRESHOLDS,
  PERSONA_TEMPLATE_PLACEHOLDERS,
  PROMPT_VERSION,
  renderTemplate,
  validateGenerationInput,
} from "./prompt/build";
export { BUNDLED_TEMPLATES, readTemplates, SYSTEM_PROMPT } from "./prompt/templates";
export type { TemplateName, Templates } from "./prompt/templates";
export { generatePersonaInstructions } from "./prompt/tone";

export {
  sanitizeCommentForLLM,
  sanitizeCommitForLLM,
  sanitizeForLLM,
  sanitizeTitleForLLM,
  stripHiddenText,
} from "./sanitize/llm";
export { sanitizeForPublishing } from "./sanitize/publish";
export type { SanitizeOptions } from "./sanitize/publish";

export {
  classifyByLabels,
  DEFAULT_LABEL_RULES,
  enhancedClassifyChanges,
  enhancedFallbackClassification,
  labelRulesFromCategories,
} from "./classify/rules";
export type { ClassifierOptions, LabelRule } from "./classify/rules";
export { classifyCommits, extractLabelsFromCommit } from "./classify/commits";
export { extractLinkedIssues } from "./classify/linked-issues";

export { callLLMWithSchema, parseWithSchema } from "./llm/call";
export type { CallLLMOptions, LLMResponse } from "./llm/call";
export { calculateCost, createProvider, hasPricing, PROVIDER_PRICING } from "./llm/provider";
export type { LLMProvider, ProviderConfig, ProviderCredentials } from "./llm/provider";

export { CANONICAL_RENDER_OPTIONS, renderToMarkdown, shiftHeadings } from "./render/markdown";
export type { RenderMarkdownOptions } from "./render/markdown";

export {
  findMarkedBlocks,
  parseMarkerLine,
  writeBeginMarker,
  writeEndMarker,
  writeMarkedBlock,
} from "./state/marker";
export type { MarkedBlock, MarkerFields } from "./state/marker";

export { extractPRNumbers, partitionByTitle } from "./range/pr-numbers";
export type { PRNumberExtraction } from "./range/pr-numbers";
export { compareSemver, parseSemver } from "./util/semver";
