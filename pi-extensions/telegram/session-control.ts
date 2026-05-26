import path from "node:path";

import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";

import {
	getTelegramFixedCommands,
	getTelegramSkillAliasCollisionReason,
	getTelegramSkillAliasFixedCommandCollisionReason,
	getTelegramSkillAliasTooLongReason,
	getTelegramSkillAliasUnsupportedReason,
	truncateTelegramCommandDescription,
} from "./texts-user.js";
import type {
	TelegramCommandPublicationState,
	TelegramPublishedCommand,
	TelegramPublishedSkillCommand,
	TelegramUnpublishedSkillCommand,
} from "./types.js";

const TELEGRAM_COMMAND_MAX_LENGTH = 32;

export const TELEGRAM_FIXED_COMMANDS: TelegramPublishedCommand[] = getTelegramFixedCommands();

function normalizeSkillName(commandName: string): string | undefined {
	if (!commandName.startsWith("skill:")) return undefined;
	const skillName = commandName.slice("skill:".length).trim();
	return skillName || undefined;
}

export function buildTelegramSkillAlias(skillName: string): {
	command?: string;
	attemptedCommand: string;
	reason?: string;
} {
	const sanitized = skillName.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]+/g, "");
	const attemptedCommand = `skill_${sanitized}`;
	if (!sanitized) {
		return {
			attemptedCommand,
			reason: getTelegramSkillAliasUnsupportedReason(),
		};
	}
	if (attemptedCommand.length > TELEGRAM_COMMAND_MAX_LENGTH) {
		return {
			attemptedCommand,
			reason: getTelegramSkillAliasTooLongReason(),
		};
	}
	if (!/^[a-z][a-z0-9_]*$/.test(attemptedCommand)) {
		return {
			attemptedCommand,
			reason: getTelegramSkillAliasUnsupportedReason(),
		};
	}
	return { command: attemptedCommand, attemptedCommand };
}

export function buildTelegramCommandPublicationState(
	commands: SlashCommandInfo[],
): TelegramCommandPublicationState {
	const fixedCommands = [...TELEGRAM_FIXED_COMMANDS];
	const fixedNames = new Set(fixedCommands.map((command) => command.command));
	const rawSkills = commands
		.filter((command) => command.source === "skill")
		.map((command) => {
			const skillName = normalizeSkillName(command.name);
			if (!skillName) return undefined;
			const alias = buildTelegramSkillAlias(skillName);
			return {
				skillName,
				description: truncateTelegramCommandDescription(
					command.description,
					`Run the ${skillName} skill`,
				),
				filePath: command.sourceInfo.path,
				baseDir: command.sourceInfo.baseDir || path.dirname(command.sourceInfo.path),
				...alias,
			};
		})
		.filter((command): command is NonNullable<typeof command> => Boolean(command))
		.sort((left, right) => left.skillName.localeCompare(right.skillName));

	const collisions = new Map<string, number>();
	for (const skill of rawSkills) {
		if (!skill.command) continue;
		collisions.set(skill.command, (collisions.get(skill.command) || 0) + 1);
	}

	const publishedSkills: TelegramPublishedSkillCommand[] = [];
	const unpublishedSkills: TelegramUnpublishedSkillCommand[] = [];
	for (const skill of rawSkills) {
		if (!skill.command) {
			unpublishedSkills.push({
				skillName: skill.skillName,
				description: skill.description,
				attemptedCommand: skill.attemptedCommand,
				reason: skill.reason || getTelegramSkillAliasUnsupportedReason(),
				filePath: skill.filePath,
				baseDir: skill.baseDir,
			});
			continue;
		}
		if (fixedNames.has(skill.command)) {
			unpublishedSkills.push({
				skillName: skill.skillName,
				description: skill.description,
				attemptedCommand: skill.command,
				reason: getTelegramSkillAliasFixedCommandCollisionReason(),
				filePath: skill.filePath,
				baseDir: skill.baseDir,
			});
			continue;
		}
		if ((collisions.get(skill.command) || 0) > 1) {
			unpublishedSkills.push({
				skillName: skill.skillName,
				description: skill.description,
				attemptedCommand: skill.command,
				reason: getTelegramSkillAliasCollisionReason(),
				filePath: skill.filePath,
				baseDir: skill.baseDir,
			});
			continue;
		}
		publishedSkills.push({
			skillName: skill.skillName,
			command: skill.command,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
		});
	}

	const publishedCommands = [
		...fixedCommands,
		...publishedSkills.map((skill) => ({
			command: skill.command,
			description: skill.description,
		})),
	];

	return {
		fixedCommands,
		publishedCommands,
		publishedSkills,
		unpublishedSkills,
		refreshedAt: new Date().toISOString(),
	};
}

import { buildTelegramSkillPrompt as buildTelegramSkillPromptText } from "./texts-agent.js";

export function buildTelegramSkillPrompt(skill: TelegramPublishedSkillCommand, task: string): string {
	return buildTelegramSkillPromptText({
		skillName: skill.skillName,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		task,
	});
}

export {
	formatTelegramAttachWarning,
	formatTelegramHelpMessage,
	formatTelegramSkillsMessage,
} from "./texts-user.js";
