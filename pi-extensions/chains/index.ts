import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "../deps.js";
import { loadChains, loadSkills } from "./loader.js";
import { ChainRuntime } from "./runtime.js";

function formatChainSummary(name: string, errors: string[]): string {
	if (errors.length === 0) return `${name} ✓`;
	return `${name} ✗ ${errors[0]}`;
}

export default function (pi: ExtensionAPI): void {
	const runtime = new ChainRuntime(pi);
	runtime.registerTools();

	pi.registerMessageRenderer("chains-control", (_message, _options, theme) => new Text(theme.fg("muted", "↻ chain feedback"), 0, 0));
	pi.registerMessageRenderer("chains-advance", (_message, _options, theme) => new Text(theme.fg("muted", "↻ chain continues"), 0, 0));
	pi.registerMessageRenderer("chains-event", (message, _options, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
		return new Text(theme.fg("muted", content), 0, 0);
	});

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const [chains, skills] = await Promise.all([loadChains(ctx.cwd), loadSkills(ctx.cwd)]);
		runtime.setResources(chains, skills, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await runtime.handleSessionShutdown(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		return runtime.handleBeforeAgentStart(event, ctx);
	});

	pi.on("tool_call", async (event, _ctx) => runtime.handleToolCall(event));
	pi.on("tool_result", async (event, _ctx) => runtime.handleToolResult(event));
	pi.on("turn_end", async (event, ctx) => runtime.handleTurnEnd(event, ctx));

	pi.on("context", async (event) => ({
		messages: runtime.buildContextMessages(event.messages) as typeof event.messages,
	}));

	pi.registerCommand("chains", {
		description: "List, activate, or deactivate chains",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "pick";
			const chains = runtime.getAvailableChains();
			const active = runtime.getState()?.chainName;

			if (sub === "off" || sub === "deactivate") {
				runtime.deactivate(ctx);
				ctx.ui.notify("Chain mode off", "info");
				return;
			}

			if (sub === "status") {
				ctx.ui.notify(active ? `Active chain: ${active}` : "No active chain", "info");
				return;
			}

			if (sub === "list") {
				const lines = chains.map((chain) => formatChainSummary(chain.name, chain.validationErrors));
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No chains found in .pi/chains/", "info");
				return;
			}

			if (sub === "activate" || sub === "use") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify("Usage: /chains activate <name>", "error");
					return;
				}
				const ok = runtime.activate(name, ctx);
				if (!ok) {
					const chain = chains.find((item) => item.name === name);
					if (!chain) {
						ctx.ui.notify(`Unknown chain: ${name}`, "error");
						return;
					}
					ctx.ui.notify(`Cannot activate ${name}:\n${chain.validationErrors.join("\n")}`, "error");
					return;
				}
				ctx.ui.notify(`Chain "${name}" armed. Send the next prompt to start it.`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(
					chains.length > 0 ? chains.map((chain) => formatChainSummary(chain.name, chain.validationErrors)).join("\n") : "No chains found in .pi/chains/",
					"info",
				);
				return;
			}

			if (chains.length === 0) {
				ctx.ui.notify("No chains found in .pi/chains/", "info");
				return;
			}
			const choices = chains.map((chain) => (chain.validationErrors.length === 0 ? chain.name : `${chain.name} (invalid)`));
			if (active) choices.unshift(`Deactivate current chain (${active})`);
			const choice = await ctx.ui.select("Select a chain", choices);
			if (!choice) return;
			if (choice.startsWith("Deactivate current chain")) {
				runtime.deactivate(ctx);
				ctx.ui.notify("Chain mode off", "info");
				return;
			}
			const name = choice.replace(/ \(invalid\)$/, "");
			const ok = runtime.activate(name, ctx);
			if (!ok) {
				const chain = chains.find((item) => item.name === name);
				if (chain) {
					ctx.ui.notify(`Cannot activate ${name}:\n${chain.validationErrors.join("\n")}`, "error");
				}
				return;
			}
			ctx.ui.notify(`Chain "${name}" armed. Send the next prompt to start it.`, "info");
		},
	});

	pi.registerCommand("chain", {
		description: "Activate a chain: /chain <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /chain <name>", "error");
				return;
			}
			const ok = runtime.activate(name, ctx);
			if (!ok) {
				const chain = runtime.getAvailableChains().find((item) => item.name === name);
				if (!chain) {
					ctx.ui.notify(`Unknown chain: ${name}`, "error");
					return;
				}
				ctx.ui.notify(`Cannot activate ${name}:\n${chain.validationErrors.join("\n")}`, "error");
				return;
			}
			ctx.ui.notify(`Chain "${name}" armed. Send the next prompt to start it.`, "info");
		},
	});

	pi.registerCommand("chain-off", {
		description: "Deactivate the current chain",
		handler: async (_args, ctx) => {
			runtime.deactivate(ctx);
			ctx.ui.notify("Chain mode off", "info");
		},
	});
}
