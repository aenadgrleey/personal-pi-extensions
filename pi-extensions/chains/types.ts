export type ChainOutputKind = "text" | "findings" | "plan" | "review" | "report";

export interface ChainSkillRef {
	name: string;
	instruction?: string;
}

export interface ChainToolsPolicy {
	mode: "allowlist";
	allow: string[];
}

export interface ChainBaseNode {
	id: string;
	review?: boolean;
}

export interface ChainStepNode extends ChainBaseNode {
	agent: string;
	task: string;
	output: {
		kind: ChainOutputKind;
	};
	tools?: ChainToolsPolicy;
	skills?: ChainSkillRef[];
}

export interface ChainLoopNode extends ChainBaseNode {
	loop: {
		max_iterations: number;
		steps: ChainNode[];
	};
}

export type ChainNode = ChainStepNode | ChainLoopNode;

export interface ChainFile {
	version: "1";
	steps: ChainNode[];
}

export interface LoadedChain extends ChainFile {
	name: string;
	filePath: string;
	allNodes: Map<string, ChainNode>;
	validationErrors: string[];
}

export interface LoadedSkill {
	name: string;
	description?: string;
	filePath: string;
	body: string;
}

export const OUTPUT_KIND_FIELDS: Record<ChainOutputKind, string[]> = {
	text: ["text"],
	findings: ["summary", "files", "insights"],
	plan: ["title", "phases", "context"],
	review: ["decision", "summary", "feedback"],
	report: ["summary", "artifacts", "notes"],
};

export function isChainOutputKind(value: string): value is ChainOutputKind {
	return value in OUTPUT_KIND_FIELDS;
}
