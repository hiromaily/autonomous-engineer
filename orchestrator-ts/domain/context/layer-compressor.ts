import type {
	CompressionResult,
	CompressionTechnique,
	ILayerCompressor,
	LayerId,
} from "../../application/ports/context";

// Compiled once at module load; reused across all compress() calls.
const HEADING_OR_LISTITEM = /^#{1,4}\s|^\s*[-*]\s/;
const EXPORT_DECLARATION = /^export\s+(function|class|interface|type|const|abstract)/;
const MEMORY_SCORE_FILTER = 0.3;

export class LayerCompressor implements ILayerCompressor {
	compress(
		layerId: LayerId,
		content: string,
		budget: number,
		tokenCounter: (text: string) => number,
	): CompressionResult {
		const originalTokenCount = tokenCounter(content);

		// Guard: never compress system-level layers
		if (layerId === "systemInstructions" || layerId === "taskDescription") {
			console.warn(
				`[LayerCompressor] compress() called on guarded layer "${layerId}" — returning original content unchanged`,
			);
			return {
				compressed: content,
				tokenCount: originalTokenCount,
				technique: "truncation",
				originalTokenCount,
			};
		}

		let extracted: string;
		let technique: CompressionTechnique;

		switch (layerId) {
			case "activeSpecification": {
				extracted = this.extractSpec(content);
				technique = "spec_extraction";
				break;
			}
			case "codeContext": {
				extracted = this.extractCodeSkeleton(content);
				technique = "code_skeleton";
				break;
			}
			case "memoryRetrieval": {
				extracted = this.filterMemoryByScore(content);
				technique = "memory_score_filter";
				break;
			}
			default: {
				// repositoryState, toolResults — fall through to truncation check
				extracted = content;
				technique = "truncation";
				break;
			}
		}

		// Truncation fallback: if extraction still exceeds budget, slice by chars
		if (tokenCounter(extracted) > budget) {
			extracted = extracted.slice(0, budget * 4);
			technique = "truncation";
		}

		const tokenCount = tokenCounter(extracted);
		return {
			compressed: extracted,
			tokenCount,
			technique,
			originalTokenCount,
		};
	}

	// ---------------------------------------------------------------------------
	// Spec extraction: keep headings (# through ####) and list items
	// ---------------------------------------------------------------------------

	private extractSpec(content: string): string {
		const lines = content.split("\n");
		const kept: string[] = [];
		for (const line of lines) {
			if (HEADING_OR_LISTITEM.test(line)) {
				kept.push(line);
			}
		}
		return kept.join("\n");
	}

	// ---------------------------------------------------------------------------
	// Code skeleton extraction: keep only `export ...` declaration lines
	// ---------------------------------------------------------------------------

	private extractCodeSkeleton(content: string): string {
		return content
			.split("\n")
			.filter((line) => EXPORT_DECLARATION.test(line))
			.join("\n");
	}

	// ---------------------------------------------------------------------------
	// Memory score filter: parse JSON entries and drop those below 0.3
	// ---------------------------------------------------------------------------

	private filterMemoryByScore(content: string): string {
		const lines = content.split("\n").filter((l) => l.trim() !== "");
		const kept: string[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const score = entry.relevanceScore;
				if (typeof score === "number" && score >= MEMORY_SCORE_FILTER) {
					kept.push(line);
				}
				// else drop (score too low or missing)
			} catch {
				// malformed JSON — drop silently
			}
		}
		return kept.join("\n");
	}
}
