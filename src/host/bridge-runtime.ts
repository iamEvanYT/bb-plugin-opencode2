import {
  createBridgeIo,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  THREAD_DELTA_NOTIFICATION_METHOD,
  type BridgeToolCallRequest,
} from "@get-bb/plugin-sdk/provider-bridge";
import { timelineDeltasForEmission } from "./timeline.ts";
import type { OpenCodeRecord } from "./types.ts";

const io = createBridgeIo();
const RUNTIME_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const pendingRuntimeRequests = new Map<
  string | number,
  (response: OpenCodeRecord) => void
>();
let nextRuntimeRequestId = 0;

export const send = io.send;
export const sendError = io.sendError;
export const sendResult = io.sendResult;

export function createDynamicToolCallRouter(
  sendToolCall: (request: BridgeToolCallRequest) => void,
) {
  const tracker = createPendingToolCallTracker({ sendToolCall });
  return {
    forward: tracker.forwardToolCall,
    resolve: tracker.resolvePendingToolCalls,
    handleRuntimeResponse(raw: unknown) {
      const response = decodeBridgeJsonRpcResponse(raw);
      return response ? tracker.handleToolCallResponse(response) : false;
    },
  };
}

export const dynamicToolCallRouter = createDynamicToolCallRouter(send);

export function notify(method: string, params: OpenCodeRecord): void {
  send({ jsonrpc: "2.0", method, params });
}

export function emit(threadId: string, deltas: OpenCodeRecord[]): void {
  if (deltas.length === 0) return;
  notify(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId,
    deltas: timelineDeltasForEmission(deltas),
  });
}

export function requestRuntime<T = OpenCodeRecord>(
  method: string,
  params: OpenCodeRecord,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const id = ++nextRuntimeRequestId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      pendingRuntimeRequests.delete(id);
      cleanup();
      reject(new Error(`BB runtime request cancelled: ${method}`));
    };
    const timeout = setTimeout(() => {
      pendingRuntimeRequests.delete(id);
      cleanup();
      reject(new Error(`BB runtime request timed out: ${method}`));
    }, RUNTIME_REQUEST_TIMEOUT_MS);
    timeout.unref();
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    pendingRuntimeRequests.set(id, (response) => {
      cleanup();
      const error = response.error as OpenCodeRecord | undefined;
      if (error) {
        reject(
          new Error(
            typeof error.message === "string"
              ? error.message
              : "BB runtime request failed",
          ),
        );
      } else {
        resolve(response.result as T);
      }
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

export function handleRuntimeResponse(input: OpenCodeRecord): boolean {
  if (dynamicToolCallRouter.handleRuntimeResponse(input)) return true;
  const id = input.id;
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    !pendingRuntimeRequests.has(id)
  ) {
    return false;
  }
  const resolve = pendingRuntimeRequests.get(id)!;
  pendingRuntimeRequests.delete(id);
  resolve(input);
  return true;
}

export function rejectPendingRuntimeRequests(reason: string): void {
  const response = { error: { message: reason } };
  for (const resolve of pendingRuntimeRequests.values()) resolve(response);
  pendingRuntimeRequests.clear();
}
