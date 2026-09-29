import { isStepCount, streamText, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { TUTOR_BRIEF, turnInstructions } from "./brief";
import { makeTools, type ToolContext } from "./tools";
import { MAX_STEPS, type Proposal, type RunTurn, type TurnEvent } from "./types";

/** Minimal push queue exposed as an async iterable; closed once, never throws to the consumer. */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      }
    };
  }
}

/**
 * A provider call that throws (bad key, network down) is turned into a stream that carries
 * one `error` part. The SDK handles in-stream errors cleanly; a thrown `doStream` leaves a
 * rejected internal promise that workerd reports as "Uncaught (in promise)" even though
 * nothing is lost. The turn still ends in the `error` event either way.
 */
const softFailStream: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapStream: async ({ doStream }) => {
    try {
      return await doStream();
    } catch (error) {
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "error", error });
            controller.close();
          }
        })
      };
    }
  }
};

function withSoftFail(model: LanguageModel): LanguageModel {
  return typeof model === "string" ? model : wrapLanguageModel({ model, middleware: softFailStream });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * One turn of the tutor. Mutates `log` in place (messages, proposals, fate.recommended,
 * turns, skipped) and resolves `done` with it whether or not the model call succeeded,
 * so the caller can always persist. Events are yielded as they happen; `done` (or
 * `error`) is always the last one.
 */
export const runTurn: RunTurn = ({ env, model, log, input, now }) => {
  const queue = new EventQueue<TurnEvent>();
  const proposalsThisTurn: Proposal[] = [];

  let userMessage: string;
  if ("start" in input) userMessage = "[session start]";
  else if ("action" in input) { userMessage = "[skip to proposals]"; log.skipped = true; }
  else userMessage = input.message;
  log.messages.push({ role: "user", content: userMessage });

  const ctx: ToolContext = { env, promptId: log.promptId, log, proposalsThisTurn, emit: e => queue.push(e), now };
  const toolsCalled: string[] = [];
  const startedMs = Date.now();
  const turn: (typeof log.turns)[number] = {
    at: now.toISOString(),
    userMessage: "start" in input ? null : userMessage,
    steps: 0,
    tools: toolsCalled,
    ms: 0
  };

  const done = (async () => {
    try {
      const result = streamText({
        model: withSoftFail(model),
        instructions: TUTOR_BRIEF + "\n\n" + turnInstructions(log),
        messages: [...log.messages],
        tools: makeTools(ctx),
        stopWhen: isStepCount(MAX_STEPS)
      });

      let streamError: unknown = null;
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") queue.push({ type: "text-delta", text: part.text });
        else if (part.type === "tool-call") toolsCalled.push(part.toolName);
        else if (part.type === "error") streamError = part.error ?? new Error("model stream error");
      }
      if (streamError) throw streamError;

      const messages = await result.responseMessages;
      log.messages.push(...messages);
      turn.steps = (await result.steps).length;
    } catch (err) {
      turn.error = errorMessage(err);
    }

    log.proposals.push(...proposalsThisTurn);
    turn.ms = Date.now() - startedMs;
    log.turns.push(turn);
    if (turn.error) queue.push({ type: "error", message: turn.error });
    else queue.push({ type: "done", log: { id: log.id, skipped: log.skipped, proposalCount: log.proposals.length } });
    queue.close();
    return log;
  })();

  return { events: queue, done };
};
