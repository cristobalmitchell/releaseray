/**
 * Unit tests for Persona Utilities
 *
 * Tests generatePersonaInstructions function that creates LLM
 * instructions based on slider values for persona customization.
 *
 * Carried from apps/app/src/lib/persona-utils.test.ts at 7d1d56f8.
 */

import { describe, it, expect } from "vitest";
import { generatePersonaInstructions } from "../../../src/core/prompt/tone";

describe("Persona Utilities", () => {
  // ============================================================================
  // generatePersonaInstructions Tests
  // ============================================================================

  describe("generatePersonaInstructions", () => {
    // ============================================================================
    // Basic Output Structure
    // ============================================================================

    describe("Basic Output Structure", () => {
      it("should return a string with tone characteristics", () => {
        const result = generatePersonaInstructions(50, 50, 50, 50);

        expect(typeof result).toBe("string");
        expect(result).toContain("**Tone Characteristics:**");
      });

      it("should include all four dimensions", () => {
        const result = generatePersonaInstructions(50, 50, 50, 50);

        expect(result).toContain("**Formality");
        expect(result).toContain("**Technical Depth");
        expect(result).toContain("**Enthusiasm");
        expect(result).toContain("**Detail Level");
      });

      it("should include the slider values in output", () => {
        const result = generatePersonaInstructions(25, 50, 75, 100);

        expect(result).toContain("(25/100)");
        expect(result).toContain("(50/100)");
        expect(result).toContain("(75/100)");
        expect(result).toContain("(100/100)");
      });
    });

    // ============================================================================
    // Formality Level Tests
    // ============================================================================

    describe("Formality Level", () => {
      it("should use casual language for low formality (0-24)", () => {
        const result = generatePersonaInstructions(10, 50, 50, 50);

        expect(result).toContain("casual, friendly language");
        expect(result).toContain("contractions");
      });

      it("should use conversational language for moderate-low formality (25-49)", () => {
        const result = generatePersonaInstructions(30, 50, 50, 50);

        expect(result).toContain("conversational language");
        expect(result).toContain("friendly, accessible tone");
      });

      it("should use professional but approachable for mid formality (50-74)", () => {
        const result = generatePersonaInstructions(60, 50, 50, 50);

        expect(result).toContain("professional but approachable");
        expect(result).toContain("Balance formality");
      });

      it("should use formal professional language for high formality (75-100)", () => {
        const result = generatePersonaInstructions(85, 50, 50, 50);

        expect(result).toContain("formal, professional language");
        expect(result).toContain("executive-ready");
      });

      it("should handle edge case of 0", () => {
        const result = generatePersonaInstructions(0, 50, 50, 50);

        expect(result).toContain("casual, friendly language");
      });

      it("should handle edge case of 100", () => {
        const result = generatePersonaInstructions(100, 50, 50, 50);

        expect(result).toContain("formal, professional language");
      });

      it("should handle boundary at 25", () => {
        const result = generatePersonaInstructions(25, 50, 50, 50);

        expect(result).toContain("conversational language");
      });

      it("should handle boundary at 50", () => {
        const result = generatePersonaInstructions(50, 50, 50, 50);

        expect(result).toContain("professional but approachable");
      });

      it("should handle boundary at 75", () => {
        const result = generatePersonaInstructions(75, 50, 50, 50);

        expect(result).toContain("formal, professional language");
      });
    });

    // ============================================================================
    // Technical Depth Tests
    // ============================================================================

    describe("Technical Depth", () => {
      it("should use plain language for low technical depth (0-24)", () => {
        const result = generatePersonaInstructions(50, 10, 50, 50);

        expect(result).toContain("plain language only");
        expect(result).toContain("avoid all technical terminology");
        expect(result).toContain("benefits and outcomes");
      });

      it("should minimize jargon for moderate-low technical depth (25-49)", () => {
        const result = generatePersonaInstructions(50, 30, 50, 50);

        expect(result).toContain("Minimize technical jargon");
        expect(result).toContain("user perspective");
      });

      it("should balance technical and plain for mid technical depth (50-74)", () => {
        const result = generatePersonaInstructions(50, 60, 50, 50);

        expect(result).toContain("Balance technical details");
        expect(result).toContain("Define technical terms");
      });

      it("should use full technical details for high technical depth (75-100)", () => {
        const result = generatePersonaInstructions(50, 90, 50, 50);

        expect(result).toContain("technical details");
        expect(result).toContain("implementation specifics");
        expect(result).toContain("file paths");
        expect(result).toContain("API changes");
      });
    });

    // ============================================================================
    // Enthusiasm Level Tests
    // ============================================================================

    describe("Enthusiasm Level", () => {
      it("should use matter-of-fact language for low enthusiasm (0-24)", () => {
        const result = generatePersonaInstructions(50, 50, 10, 50);

        expect(result).toContain("matter-of-fact");
        expect(result).toContain("straightforward language");
        expect(result).toContain("factual descriptions");
      });

      it("should use neutral language for moderate-low enthusiasm (25-49)", () => {
        const result = generatePersonaInstructions(50, 50, 30, 50);

        expect(result).toContain("neutral, objective language");
        expect(result).toContain("without emotional emphasis");
      });

      it("should use positive but balanced for mid enthusiasm (50-74)", () => {
        const result = generatePersonaInstructions(50, 50, 60, 50);

        expect(result).toContain("positive but balanced");
        expect(result).toContain("appropriate excitement");
      });

      it("should use enthusiastic language for high enthusiasm (75-100)", () => {
        const result = generatePersonaInstructions(50, 50, 90, 50);

        expect(result).toContain("enthusiastic, excited language");
        expect(result).toContain("positive impact");
        expect(result).toContain("power words");
      });
    });

    // ============================================================================
    // Detail Level Tests
    // ============================================================================

    describe("Detail Level", () => {
      it("should use brief descriptions for low detail (0-24)", () => {
        const result = generatePersonaInstructions(50, 50, 50, 10);

        expect(result).toContain("brief, high-level descriptions");
        expect(result).toContain("1-2 sentences maximum");
        expect(result).toContain("most critical information");
      });

      it("should use concise descriptions for moderate-low detail (25-49)", () => {
        const result = generatePersonaInstructions(50, 50, 50, 30);

        expect(result).toContain("concise");
        expect(result).toContain("essential information");
      });

      it("should use moderate detail for mid detail level (50-74)", () => {
        const result = generatePersonaInstructions(50, 50, 50, 60);

        expect(result).toContain("moderate detail");
        expect(result).toContain("key points highlighted");
      });

      it("should use comprehensive detail for high detail level (75-100)", () => {
        const result = generatePersonaInstructions(50, 50, 50, 90);

        expect(result).toContain("comprehensive explanations");
        expect(result).toContain("context and examples");
        expect(result).toContain("background information");
        expect(result).toContain("usage examples");
      });
    });

    // ============================================================================
    // Persona Presets (Common Combinations)
    // ============================================================================

    describe("Persona Presets", () => {
      it("should generate appropriate instructions for Engineer persona (high tech, formal)", () => {
        // Engineer: high formality, high technical, moderate enthusiasm, high detail
        const result = generatePersonaInstructions(80, 90, 50, 85);

        expect(result).toContain("formal, professional language");
        expect(result).toContain("technical details");
        expect(result).toContain("implementation specifics");
        expect(result).toContain("comprehensive explanations");
      });

      it("should generate appropriate instructions for Customer persona (low tech, enthusiastic)", () => {
        // Customer: mid formality, low technical, high enthusiasm, mid detail
        const result = generatePersonaInstructions(50, 20, 80, 50);

        expect(result).toContain("professional but approachable");
        expect(result).toContain("plain language only");
        expect(result).toContain("enthusiastic, excited language");
        expect(result).toContain("moderate detail");
      });

      it("should generate appropriate instructions for Internal persona (balanced)", () => {
        // Internal: mid formality, mid technical, mid enthusiasm, mid detail
        const result = generatePersonaInstructions(50, 50, 50, 50);

        expect(result).toContain("professional but approachable");
        expect(result).toContain("Balance technical details");
        expect(result).toContain("positive but balanced");
        expect(result).toContain("moderate detail");
      });

      it("should generate appropriate instructions for Executive Summary persona", () => {
        // Executive: high formality, low technical, neutral, brief
        const result = generatePersonaInstructions(90, 15, 40, 20);

        expect(result).toContain("formal, professional language");
        expect(result).toContain("plain language only");
        expect(result).toContain("neutral, objective language");
        expect(result).toContain("brief, high-level descriptions");
      });
    });

    // ============================================================================
    // Edge Cases
    // ============================================================================

    describe("Edge Cases", () => {
      it("should handle all zeros", () => {
        const result = generatePersonaInstructions(0, 0, 0, 0);

        expect(result).toContain("(0/100)");
        expect(result).toContain("casual, friendly language");
        expect(result).toContain("plain language only");
        expect(result).toContain("matter-of-fact");
        expect(result).toContain("brief, high-level descriptions");
      });

      it("should handle all 100s", () => {
        const result = generatePersonaInstructions(100, 100, 100, 100);

        expect(result).toContain("(100/100)");
        expect(result).toContain("formal, professional language");
        expect(result).toContain("technical details");
        expect(result).toContain("enthusiastic, excited language");
        expect(result).toContain("comprehensive explanations");
      });

      it("should handle mixed extreme values", () => {
        const result = generatePersonaInstructions(0, 100, 0, 100);

        expect(result).toContain("casual, friendly language");
        expect(result).toContain("technical details");
        expect(result).toContain("matter-of-fact");
        expect(result).toContain("comprehensive explanations");
      });

      it("should produce consistent output for same inputs", () => {
        const result1 = generatePersonaInstructions(50, 50, 50, 50);
        const result2 = generatePersonaInstructions(50, 50, 50, 50);

        expect(result1).toBe(result2);
      });

      it("should produce different output for different inputs", () => {
        const result1 = generatePersonaInstructions(25, 25, 25, 25);
        const result2 = generatePersonaInstructions(75, 75, 75, 75);

        expect(result1).not.toBe(result2);
      });
    });
  });
});
