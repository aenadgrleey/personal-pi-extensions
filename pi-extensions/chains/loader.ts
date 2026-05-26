import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
	ChainFile,
	ChainLoopNode,
	ChainNode,
	ChainOutputKind,
	ChainStepNode,
	LoadedChain,
	LoadedSkill,
} from "./types.js";
import { OUTPUT_KIND_FIELDS, isChainOutputKind } from "./types.js";

const CHAIN_DIR = path.join(".pi", "chains");
const SKILL_DIR = "skills";

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
	if (!raw.startsWith("---\n")) return { data: {}, body: raw };

	const end = raw.indexOf("\n---\n", 4);
	if (end < 0) return { data: {}, body: raw };

	const header = raw.slice(4, end);
	const body = raw.slice(end + 5);
	const data = (yaml.load(header) as Record<string, unknown> | undefined) ?? {};
	return { data, body };
}

function loadSkillFromFile(filePath: string, raw: string): LoadedSkill {
	const parsed = parseFrontmatter(raw);
	const nameFromFile = path.basename(path.dirname(filePath));
	const name = typeof parsed.data.name === "string" && parsed.data.name.trim() ? parsed.data.name.trim() : nameFromFile;
	const description = typeof parsed.data.description === "string" ? parsed.data.description.trim() : undefined;
	return { name, description, filePath, body: parsed.body.trim() };
}

async function collectSkillFiles(dir: string, out: string[] = []): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectSkillFiles(fullPath, out);
			continue;
		}
		if (entry.isFile() && entry.name === "SKILL.md") out.push(fullPath);
	}

	return out;
}

export async function loadSkills(cwd: string): Promise<Map<string, LoadedSkill>> {
	const skillFiles = await collectSkillFiles(path.join(cwd, SKILL_DIR));
	const skills = new Map<string, LoadedSkill>();

	for (const filePath of skillFiles.sort()) {
		try {
			const raw = await fs.readFile(filePath, "utf8");
			const skill = loadSkillFromFile(filePath, raw);
			skills.set(skill.name, skill);
		} catch {
			// ignore unreadable skill files
		}
	}

	return skills;
}

function getNodeKind(node: ChainNode): "step" | "loop" {
	if ("agent" in node) return "step";
	return "loop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getOutputKind(node: ChainNode): ChainOutputKind | undefined {
	if (!("output" in node)) return undefined;
	const kind = node.output?.kind;
	return typeof kind === "string" && isChainOutputKind(kind) ? kind : undefined;
}

function collectRefs(text: string): string[] {
	const refs: string[] = [];
	for (const match of text.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
		const expr = match[1]?.trim();
		if (expr) refs.push(expr);
	}
	return refs;
}

function validateInterpolation(
	text: string,
	allNodes: Map<string, ChainNode>,
	pathLabel: string,
	errors: string[],
): void {
	for (const ref of collectRefs(text)) {
		if (ref === "input" || ref === "prev") continue;
		if (ref.startsWith("prev.")) continue;
		if (!ref.startsWith("steps.")) {
			errors.push(`${pathLabel}: unsupported interpolation reference "{{${ref}}}"`);
			continue;
		}

		const parts = ref.split(".");
		const stepId = parts[1];
		if (!stepId) {
			errors.push(`${pathLabel}: invalid interpolation reference "{{${ref}}}"`);
			continue;
		}

		const node = allNodes.get(stepId);
		if (!node) {
			errors.push(`${pathLabel}: unknown step reference "${stepId}" in "{{${ref}}}"`);
			continue;
		}

		const kind = getOutputKind(node);
		if (!kind) continue;
		const allowedFields = new Set(OUTPUT_KIND_FIELDS[kind]);
		const field = parts[2];
		if (field && !allowedFields.has(field)) {
			errors.push(`${pathLabel}: invalid field "${field}" for step "${stepId}" output kind "${kind}"`);
		}
	}
}

function validateNode(
	node: ChainNode,
	allNodes: Map<string, ChainNode>,
	errors: string[],
	seen: Set<string>,
	pathLabel: string,
	insideLoopBody: boolean,
	referencedSkills: Set<string>,
): void {
	if (!isRecord(node)) {
		errors.push(`${pathLabel}: node must be a YAML mapping`);
		return;
	}
	if (!node.id || typeof node.id !== "string") {
		errors.push(`${pathLabel}: missing or invalid node id`);
		return;
	}

	if (seen.has(node.id)) {
		errors.push(`${pathLabel}: duplicate node id "${node.id}"`);
	} else {
		seen.add(node.id);
	}

	const hasAgent = "agent" in node;
	const hasLoop = "loop" in node;
	const shapes = [hasAgent, hasLoop].filter(Boolean).length;
	if (shapes !== 1) {
		errors.push(`${pathLabel}: node "${node.id}" must define exactly one of agent or loop`);
	}
	const kind = getNodeKind(node);
	if (insideLoopBody && node.review) {
		errors.push(`${pathLabel}: review is not allowed inside a loop body (node "${node.id}")`);
	}
	if (kind === "step") {
		const stepNode = node as ChainStepNode;
		if (!stepNode.task || typeof stepNode.task !== "string") {
			errors.push(`${pathLabel}: step "${node.id}" is missing task text`);
		}
		if (!stepNode.agent || typeof stepNode.agent !== "string") {
			errors.push(`${pathLabel}: step "${node.id}" is missing agent`);
		}
		const outputKind = getOutputKind(node);
		if (!outputKind) {
			errors.push(`${pathLabel}: step "${node.id}" has invalid or missing output.kind`);
		}
		if (stepNode.tools) {
			if (stepNode.tools.mode !== "allowlist") {
				errors.push(`${pathLabel}: step "${node.id}" only supports tools.mode=allowlist`);
			}
			if (!Array.isArray(stepNode.tools.allow) || stepNode.tools.allow.some((tool: string) => typeof tool !== "string" || !tool.trim())) {
				errors.push(`${pathLabel}: step "${node.id}" has invalid tools.allow list`);
			}
		}
		if (stepNode.skills) {
			for (const skill of stepNode.skills) {
				if (!skill?.name || typeof skill.name !== "string") {
					errors.push(`${pathLabel}: step "${node.id}" has a skill entry with no name`);
					continue;
				}
				referencedSkills.add(skill.name);
			}
		}
		validateInterpolation(stepNode.task, allNodes, `${pathLabel}: step "${node.id}"`, errors);
		return;
	}

	if (node.review !== undefined && typeof node.review !== "boolean") {
		errors.push(`${pathLabel}: review must be a boolean flag`);
	}

	const loopNode = node as ChainLoopNode;
	const steps = loopNode.loop?.steps;
	if (!Number.isInteger(loopNode.loop?.max_iterations) || (loopNode.loop?.max_iterations ?? 0) <= 0) {
		errors.push(`${pathLabel}: loop "${node.id}" requires max_iterations > 0`);
	}
	if (!Array.isArray(steps) || steps.length === 0) {
		errors.push(`${pathLabel}: loop block "${node.id}" needs at least one step`);
		return;
	}
	for (const child of steps) {
		validateNode(child, allNodes, errors, seen, `${pathLabel}: loop "${node.id}"`, true, referencedSkills);
	}
}

export async function loadChains(cwd: string): Promise<LoadedChain[]> {
	const chainDir = path.join(cwd, CHAIN_DIR);
	let files: string[];
	try {
		files = await fs.readdir(chainDir);
	} catch {
		return [];
	}

	const skills = await loadSkills(cwd);
	const skillNames = new Set(skills.keys());
	const loaded: LoadedChain[] = [];

	for (const file of files.filter((file) => file.endsWith(".yaml") || file.endsWith(".yml")).sort()) {
		const filePath = path.join(chainDir, file);
		const name = file.replace(/\.(yaml|yml)$/i, "");
		const validationErrors: string[] = [];
		const allNodes = new Map<string, ChainNode>();
		let parsed: ChainFile | undefined;

		try {
			const raw = await fs.readFile(filePath, "utf8");
			parsed = yaml.load(raw) as ChainFile;
		} catch (error) {
			validationErrors.push(`${name}: failed to read or parse YAML: ${error instanceof Error ? error.message : String(error)}`);
			loaded.push({ name, filePath, version: "1", steps: [], allNodes, validationErrors });
			continue;
		}

		if (!parsed || typeof parsed !== "object") {
			validationErrors.push(`${name}: chain file must be a YAML mapping`);
			loaded.push({ name, filePath, version: "1", steps: [], allNodes, validationErrors });
			continue;
		}

		if ((parsed as ChainFile).version !== "1") {
			validationErrors.push(`${name}: only version "1" is supported`);
		}

		if (!Array.isArray((parsed as ChainFile).steps)) {
			validationErrors.push(`${name}: missing steps array`);
			loaded.push({ name, filePath, version: "1", steps: [], allNodes, validationErrors });
			continue;
		}

		for (const node of parsed.steps) {
			const stack: unknown[] = [node];
			while (stack.length > 0) {
				const current = stack.pop();
				if (!isRecord(current)) {
					validationErrors.push(`${name}: node must be a YAML mapping`);
					continue;
				}
				if (typeof current.id !== "string" || !current.id.trim()) {
					validationErrors.push(`${name}: missing or invalid node id`);
					continue;
				}
				if (allNodes.has(current.id)) {
					validationErrors.push(`${name}: duplicate node id "${current.id}"`);
				} else {
					allNodes.set(current.id, current as unknown as ChainNode);
				}
				if ("loop" in current && isRecord(current.loop) && Array.isArray(current.loop.steps)) {
					stack.push(...current.loop.steps);
				}
			}
		}

		const referencedSkills = new Set<string>();
		const seen = new Set<string>();
		for (const node of parsed.steps) {
			validateNode(node, allNodes, validationErrors, seen, name, false, referencedSkills);
		}

		for (const skillName of referencedSkills) {
			if (!skillNames.has(skillName)) {
				validationErrors.push(`${name}: missing referenced skill "${skillName}"`);
			}
		}

		loaded.push({
			name,
			filePath,
			version: parsed.version,
			steps: parsed.steps,
			allNodes,
			validationErrors,
		});
	}

	return loaded;
}
