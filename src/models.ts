import { createAssistantMessageEventStream, type AssistantMessage, type Models, type Model, type Api, type Context, type ModelsSimpleStreamOptions, type DeferredHandle } from '@earendil-works/pi-ai';

/** Durable reports hook errors and continues. Enforce admission at the model dispatch boundary instead. */
export function guardedModels(models: Models, beforeRequest: (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions | undefined) => Promise<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }>,
  beforeDeferred: (model: Model<Api>, handle: DeferredHandle) => Promise<void>): Models {
  const guarded: Models = new Proxy(models, { get(target, key) {
    if (key === 'fetchDeferred') return (async (model, handle, options) => {
      await beforeDeferred(model, handle); options?.signal?.throwIfAborted();
      return target.fetchDeferred(model, handle, options);
    }) satisfies Models['fetchDeferred'];
    if (key === 'completeSimple') return ((model, context, options) => guarded.streamSimple(model, context, options).result()) satisfies Models['completeSimple'];
    if (key === 'streamSimple') return ((model, context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const request = await beforeRequest(model, context, options);
          options?.signal?.throwIfAborted();
          for await (const event of target.streamSimple(request.model, context, request.options)) stream.push(event);
        } catch (error) {
          const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: [], stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'error', reason: 'error', error: message });
        }
      })();
      return stream;
    }) satisfies Models['streamSimple'];
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return guarded;
}
