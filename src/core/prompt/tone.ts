/**
 * Persona Utilities
 * Helper functions for working with persona slider values and generating LLM instructions
 */

/**
 * Generate detailed LLM instructions from persona slider values
 * These instructions guide the AI's writing style based on fine-grained tone dimensions
 *
 * @param formalityLevel - 0 (casual) to 100 (formal)
 * @param technicalDepth - 0 (plain language) to 100 (technical)
 * @param enthusiasmLevel - 0 (neutral) to 100 (enthusiastic)
 * @param detailLevel - 0 (brief) to 100 (comprehensive)
 * @returns Formatted LLM instructions string
 */
export function generatePersonaInstructions(
  formalityLevel: number,
  technicalDepth: number,
  enthusiasmLevel: number,
  detailLevel: number
): string {
  let instructions = "**Tone Characteristics:**\n\n";

  // Formality instructions
  instructions += `**Formality (${formalityLevel}/100):**\n`;
  if (formalityLevel >= 75) {
    instructions += "- Use formal, professional language with precise terminology\n";
    instructions += "- Maintain a polished, executive-ready tone\n";
  } else if (formalityLevel >= 50) {
    instructions += "- Use professional but approachable language\n";
    instructions += "- Balance formality with readability\n";
  } else if (formalityLevel >= 25) {
    instructions += "- Use conversational language with some informality\n";
    instructions += "- Write in a friendly, accessible tone\n";
  } else {
    instructions += "- Use casual, friendly language\n";
    instructions += "- Feel free to use contractions and informal phrasing\n";
  }
  instructions += "\n";

  // Technical depth instructions
  instructions += `**Technical Depth (${technicalDepth}/100):**\n`;
  if (technicalDepth >= 75) {
    instructions +=
      "- Include technical details, implementation specifics, and architecture context\n";
    instructions +=
      "- Reference file paths, API changes, database schema changes, and technical metrics\n";
    instructions += "- Use industry-standard terminology and technical jargon appropriately\n";
  } else if (technicalDepth >= 50) {
    instructions += "- Balance technical details with plain language explanations\n";
    instructions += "- Define technical terms when first introduced\n";
  } else if (technicalDepth >= 25) {
    instructions += "- Minimize technical jargon, explain concepts simply\n";
    instructions += "- Focus on what changed from a user perspective\n";
  } else {
    instructions += "- Use plain language only, avoid all technical terminology\n";
    instructions += "- Focus on benefits and outcomes, not implementation details\n";
    instructions += "- Explain features in terms of what users can now do\n";
  }
  instructions += "\n";

  // Enthusiasm instructions
  instructions += `**Enthusiasm (${enthusiasmLevel}/100):**\n`;
  if (enthusiasmLevel >= 75) {
    instructions += "- Use enthusiastic, excited language to convey the value of changes\n";
    instructions += "- Emphasize positive impact and benefits prominently\n";
    instructions += "- Use power words and emotional language where appropriate\n";
  } else if (enthusiasmLevel >= 50) {
    instructions += "- Maintain a positive but balanced tone\n";
    instructions += "- Express appropriate excitement for major features\n";
  } else if (enthusiasmLevel >= 25) {
    instructions += "- Use neutral, objective language\n";
    instructions += "- State facts without emotional emphasis\n";
  } else {
    instructions += "- Use matter-of-fact, straightforward language without emotional emphasis\n";
    instructions += "- Focus purely on factual descriptions of changes\n";
  }
  instructions += "\n";

  // Detail level instructions
  instructions += `**Detail Level (${detailLevel}/100):**\n`;
  if (detailLevel >= 75) {
    instructions += "- Provide comprehensive explanations with context and examples\n";
    instructions +=
      "- Include background information, rationale, and implications for each change\n";
    instructions += "- Add usage examples and migration guidance where relevant\n";
  } else if (detailLevel >= 50) {
    instructions += "- Provide moderate detail with key points highlighted\n";
    instructions += "- Include essential context without overwhelming detail\n";
  } else if (detailLevel >= 25) {
    instructions += "- Keep descriptions concise, focusing on essential information\n";
    instructions += "- Summarize changes briefly but clearly\n";
  } else {
    instructions += "- Use brief, high-level descriptions (1-2 sentences maximum per item)\n";
    instructions += "- Focus only on the most critical information\n";
    instructions += "- Omit background context and detailed explanations\n";
  }

  return instructions;
}
