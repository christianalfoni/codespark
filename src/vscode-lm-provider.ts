import * as vscode from "vscode";

// This module bridges VSCode's Language Model API into pi-ai's provider system.
// It registers a "vscode-lm" API provider so the Agent can use Copilot models.

let piAi: any;
let _log: vscode.OutputChannel;

export async function registerVscodeLmProvider(piAiModule: any, log: vscode.OutputChannel): Promise<void> {
  piAi = piAiModule;
  _log = log;

  const AssistantMessageEventStream = piAi.AssistantMessageEventStream;

  function streamVscodeLm(
    model: any,
    context: any,
    _options?: any,
  ): typeof AssistantMessageEventStream.prototype {
    const stream = new AssistantMessageEventStream();

    (async () => {
      try {
        const vscodeLmModel = model._vscodeLmModel as
          | vscode.LanguageModelChat
          | undefined;
        if (!vscodeLmModel) {
          throw new Error("No VSCode LM model attached to model object");
        }

        const messages = convertMessages(context);
        const tools = convertTools(context.tools);

        const cancellation = new vscode.CancellationTokenSource();
        if (_options?.signal) {
          _options.signal.addEventListener("abort", () =>
            cancellation.cancel(),
          );
        }

        const requestOptions: vscode.LanguageModelChatRequestOptions = {
          justification: `CodeSpark would like to use '${vscodeLmModel.name}'. Click 'Allow' to proceed.`,
        };
        if (tools.length > 0) {
          requestOptions.tools = tools;
        }

        const response = await vscodeLmModel.sendRequest(
          messages,
          requestOptions,
          cancellation.token,
        );

        const emptyUsage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        const output: any = {
          role: "assistant",
          content: [],
          api: "vscode-lm",
          provider: "vscode",
          model: model.id,
          usage: emptyUsage,
          stopReason: "stop",
          timestamp: Date.now(),
        };

        stream.push({ type: "start", partial: output });

        let currentTextIndex: number | null = null;
        let currentText = "";

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            if (currentTextIndex === null) {
              currentTextIndex = output.content.length;
              output.content.push({ type: "text", text: "" });
              stream.push({
                type: "text_start",
                contentIndex: currentTextIndex,
                partial: output,
              });
            }
            currentText += chunk.value;
            output.content[currentTextIndex!].text = currentText;
            stream.push({
              type: "text_delta",
              contentIndex: currentTextIndex,
              delta: chunk.value,
              partial: output,
            });
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            // Close any open text block
            if (currentTextIndex !== null) {
              stream.push({
                type: "text_end",
                contentIndex: currentTextIndex,
                content: currentText,
                partial: output,
              });
              currentTextIndex = null;
              currentText = "";
            }

            const toolCallIndex = output.content.length;
            const toolCall = {
              type: "toolCall" as const,
              id: chunk.callId,
              name: chunk.name,
              arguments: chunk.input as Record<string, any>,
            };
            output.content.push(toolCall);
            output.stopReason = "toolUse";

            stream.push({
              type: "toolcall_start",
              contentIndex: toolCallIndex,
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: toolCallIndex,
              toolCall,
              partial: output,
            });
          }
        }

        // Close any open text block
        if (currentTextIndex !== null) {
          stream.push({
            type: "text_end",
            contentIndex: currentTextIndex,
            content: currentText,
            partial: output,
          });
        }

        stream.push({ type: "done", reason: output.stopReason, message: output });
      } catch (err: any) {
        _log.appendLine(`[vscode-lm] Error: ${err.message || err}`);
        const errorOutput: any = {
          role: "assistant",
          content: [],
          api: "vscode-lm",
          provider: "vscode",
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "error",
          errorMessage: err.message || String(err),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: errorOutput });
      }
    })();

    return stream;
  }

  piAi.registerApiProvider({
    api: "vscode-lm",
    stream: streamVscodeLm,
    streamSimple: streamVscodeLm,
  });
}

function convertMessages(context: any): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  // VSCode LM API has no system role — pass system prompt as Assistant message
  if (context.systemPrompt) {
    messages.push(
      vscode.LanguageModelChatMessage.Assistant(context.systemPrompt),
    );
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((c: any) => c.text || "").join("\n");
      messages.push(vscode.LanguageModelChatMessage.User(text));
    } else if (msg.role === "assistant") {
      const parts: Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
      > = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(new vscode.LanguageModelTextPart(block.text));
        } else if (block.type === "toolCall") {
          parts.push(
            new vscode.LanguageModelToolCallPart(
              block.id,
              block.name,
              block.arguments,
            ),
          );
        }
      }
      if (parts.length > 0) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
      }
    } else if (msg.role === "toolResult") {
      const resultText = msg.content
        .map((c: any) => c.text || "")
        .join("\n");
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(msg.toolCallId, [
            new vscode.LanguageModelTextPart(resultText),
          ]),
        ]),
      );
    }
  }

  return messages;
}

function convertTools(
  tools?: any[],
): vscode.LanguageModelChatTool[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  return tools.map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

export async function selectVscodeLmModel(
  vendor: string,
  family: string,
): Promise<{
  piModel: any;
  vscodeLmModel: vscode.LanguageModelChat;
} | null> {
  const models = await vscode.lm.selectChatModels({ vendor, family });
  if (models.length === 0) {
    return null;
  }

  const vscodeLmModel = models[0];

  const piModel = {
    id: vscodeLmModel.id,
    name: vscodeLmModel.name,
    api: "vscode-lm",
    provider: "vscode",
    baseUrl: "",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: vscodeLmModel.maxInputTokens,
    maxTokens: 4096,
    _vscodeLmModel: vscodeLmModel,
  };

  return { piModel, vscodeLmModel };
}
