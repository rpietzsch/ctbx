import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { StoredMessage } from '@/storage/db';
import { describeFailure, isAbort } from './errors';

/**
 * The chat turn: one `streamText` call that may take several tool-calling steps
 * (spec §6.4). Runs entirely in the browser — there is no server to stream
 * from, so the model call and the tool loop happen in the page.
 */

export interface TurnEvents {
  onTextDelta?(delta: string): void;
  onToolCall?(call: { toolCallId: string; toolName: string; args: unknown }): void;
  onToolResult?(result: { toolCallId: string; toolName: string; output: unknown }): void;
  onStepFinish?(): void;
}

export interface TurnOptions extends TurnEvents {
  model: LanguageModel;
  messages: ModelMessage[];
  tools?: ToolSet | undefined;
  maxSteps: number;
  system?: string | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface TurnResult {
  text: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Set when the turn ended in a failure the user should see. */
  failure?: { kind: string; message: string; retryable: boolean };
  aborted: boolean;
}

/** Converts stored history into the shape the AI SDK expects. */
export function toModelMessages(messages: StoredMessage[]): ModelMessage[] {
  return messages
    .filter((message) => message.content.trim() !== '' && message.error === undefined)
    .map((message) => ({ role: message.role, content: message.content }) as ModelMessage);
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  let text = '';

  try {
    const result = streamText({
      model: options.model,
      messages: options.messages,
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools && Object.keys(options.tools).length > 0 ? { tools: options.tools } : {}),
      stopWhen: stepCountIs(options.maxSteps),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          // Field name has moved between SDK majors; accept either.
          const chunk =
            (part as { text?: string; textDelta?: string }).text ??
            (part as { textDelta?: string }).textDelta ??
            '';
          if (chunk !== '') {
            text += chunk;
            options.onTextDelta?.(chunk);
          }
          break;
        }
        case 'tool-call': {
          const call = part as unknown as {
            toolCallId: string;
            toolName: string;
            input?: unknown;
            args?: unknown;
          };
          options.onToolCall?.({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.input ?? call.args,
          });
          break;
        }
        case 'tool-result': {
          const toolResult = part as unknown as {
            toolCallId: string;
            toolName: string;
            output?: unknown;
            result?: unknown;
          };
          options.onToolResult?.({
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            output: toolResult.output ?? toolResult.result,
          });
          break;
        }
        case 'finish-step':
          options.onStepFinish?.();
          break;
        case 'error':
          throw (part as unknown as { error: unknown }).error;
        default:
          break;
      }
    }

    const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
    return {
      text,
      finishReason,
      usage: usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : undefined,
      aborted: false,
    };
  } catch (error) {
    if (isAbort(error) || options.abortSignal?.aborted) {
      // A stop is a normal outcome: keep whatever was streamed.
      return { text, aborted: true };
    }
    const failure = describeFailure(error);
    return { text, aborted: false, failure };
  }
}
