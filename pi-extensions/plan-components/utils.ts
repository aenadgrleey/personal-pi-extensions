/**
 * Pure utility functions for the plan extension.
 * Extracted for testability.
 */

import * as yaml from "js-yaml";
import * as path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";

// ── Core plan types ───────────────────────────────────────────────────────

export interface PlanPhase {
	name: string;
	steps: string[];
}

/** Shape of a plan YAML file on disk. */
export interface PlanFile {
	title: string;
	saved: string;
	phases: PlanPhase[];
}

// ── Plan text builder (for LLM context / tool output) ─────────────────────

/** Build a readable plan text from phased structure. */
export function buildPlanText(title: string, phases: PlanPhase[]): string {
	const lines: string[] = [`Plan: ${title}`, ""];
	let globalStep = 1;

	for (const phase of phases) {
		lines.push(`${phase.name}`);
		for (const step of phase.steps) {
			lines.push(`${globalStep}. ${step}`);
			globalStep++;
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ── Plan YAML serialization ───────────────────────────────────────────────

/** Serialize a plan to YAML string for disk storage. */
export function formatPlanYaml(title: string, phases: PlanPhase[]): string {
	const plan: PlanFile = {
		title,
		saved: new Date().toISOString(),
		phases,
	};
	return yaml.dump(plan, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/** Parse a plan YAML string back into typed structure. */
export function parsePlanYaml(content: string): PlanFile {
	const parsed = yaml.load(content) as Record<string, unknown>;
	const title = (typeof parsed.title === "string" ? parsed.title : "Untitled Plan");
	const saved = (typeof parsed.saved === "string" ? parsed.saved : undefined);
	const rawPhases = Array.isArray(parsed.phases) ? parsed.phases : [];

	const phases: PlanPhase[] = rawPhases.map((p: Record<string, unknown>) => ({
		name: typeof p?.name === "string" ? p.name : "Untitled",
		steps: Array.isArray(p?.steps) ? p.steps.filter((s: unknown) => typeof s === "string") as string[] : [],
	})).filter((p: PlanPhase) => p.steps.length > 0);

	return { title, saved: saved ?? "", phases };
}

// ── Plan file persistence ─────────────────────────────────────────────────

export function buildPlanSaveDir(cwd: string): string {
	return path.join(cwd, ".pi", "plans");
}

export function buildPlanFilePath(cwd: string, title: string): string {
	const dir = buildPlanSaveDir(cwd);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return path.join(dir, `${slug ? `${slug}-` : ""}${timestamp}-plan.yaml`);
}

/** Save a plan as YAML to .pi/plans/ */
export async function savePlanToFile(
	cwd: string,
	title: string,
	phases: PlanPhase[],
): Promise<string> {
	const filePath = buildPlanFilePath(cwd, title);
	const content = formatPlanYaml(title, phases);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
	return filePath;
}

/** Load a plan from a YAML file. */
export async function loadPlanFile(filePath: string): Promise<PlanFile> {
	const content = await readFile(filePath, "utf8");
	return parsePlanYaml(content);
}
