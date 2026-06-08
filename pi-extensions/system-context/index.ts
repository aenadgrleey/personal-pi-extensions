import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type ModelSnapshot = {
  provider: string;
  id: string;
};

function snapshotModel(
  model: ExtensionContext["model"],
): ModelSnapshot | undefined {
  const provider = model?.provider?.trim();
  const id = model?.id?.trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

function formatModel(snapshot: ModelSnapshot): string {
  return `${snapshot.provider}/${snapshot.id}`;
}

function appendToSystemPrompt(
  systemPrompt: string | undefined,
  note: string,
): string {
  return systemPrompt && systemPrompt.length > 0
    ? `${systemPrompt}\n\n${note}`
    : note;
}

function buildNote(
  snapshot: ModelSnapshot | undefined,
  hasCurrentModel: boolean,
): string | undefined {
  if (!snapshot) return undefined;

  const modelLabel = formatModel(snapshot);
  if (hasCurrentModel) {
    return `Active model: ${modelLabel}. If the model changes later in this session, use the newest observed model. If the current model becomes unavailable, reuse the latest known model.`;
  }

  return `Active model (latest known): ${modelLabel}. If the current model is unavailable, reuse this latest known model for the session.`;
}

export default function (pi: ExtensionAPI): void {
  let latestModel: ModelSnapshot | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const current = snapshotModel(ctx.model);
    if (current) latestModel = current;
  });

  pi.on("model_select", async (event) => {
    const current = snapshotModel(event.model);
    if (current) latestModel = current;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const current = snapshotModel(ctx.model);
    if (current) latestModel = current;
    const note = buildNote(current ?? latestModel, current !== undefined);
    return note
      ? { systemPrompt: appendToSystemPrompt(event.systemPrompt, note) }
      : undefined;
  });
}
