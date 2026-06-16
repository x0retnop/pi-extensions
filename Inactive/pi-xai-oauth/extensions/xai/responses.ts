import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { isGrokCliProxyModel, xaiBaseUrlForModel, xaiModelForRequest, xaiModelRequestHeaders, xaiResponsesUrlForModel } from "./models";
import { rewriteXaiResponsesPayload } from "./payload";

/** POST a JSON body to an xAI endpoint with OAuth bearer auth. */
export async function postXaiJson(
  apiKey: string,
  url: string,
  body: Record<string, any>,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    const error = new Error(errorText);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

/** Create a single xAI Responses API response with model-aware routing. */
export async function createXaiResponse(apiKey: string, body: Record<string, any>, signal?: AbortSignal): Promise<any> {
  const model = xaiModelForRequest(typeof body.model === "string" ? body.model : undefined);
  const payload = rewriteXaiResponsesPayload(body, model) as Record<string, any>;
  const usesGrokCliProxy = isGrokCliProxyModel(model.id);
  const grokCliSessionId = usesGrokCliProxy
    ? (typeof body.previous_response_id === "string" && body.previous_response_id) || randomUUID()
    : undefined;
  return postXaiJson(
    apiKey,
    xaiResponsesUrlForModel(model.id),
    payload,
    signal,
    xaiModelRequestHeaders(model.id, grokCliSessionId),
  );
}

/** Stream pi's simple Responses flow through xAI with payload normalization. */
export function streamSimpleXaiResponses(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const grokCliSessionId = options?.sessionId || (isGrokCliProxyModel(model.id) ? randomUUID() : undefined);
  const streamModel = {
    ...model,
    baseUrl: xaiBaseUrlForModel(model.id),
    headers: {
      ...(model as any).headers,
      ...xaiModelRequestHeaders(model.id, grokCliSessionId),
    },
  };
  const headers = { ...(options?.headers || {}) };
  if (grokCliSessionId && !headers["x-grok-conv-id"]) headers["x-grok-conv-id"] = grokCliSessionId;

  return streamSimpleOpenAIResponses(streamModel as Model<"openai-responses">, context, {
    ...options,
    headers,
    async onPayload(payload) {
      const rewritten = rewriteXaiResponsesPayload(payload, streamModel, options);
      const userRewritten = await options?.onPayload?.(rewritten, streamModel);
      return userRewritten === undefined ? rewritten : userRewritten;
    },
  });
}
