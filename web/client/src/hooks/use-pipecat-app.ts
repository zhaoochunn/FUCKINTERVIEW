"use client";

import type {
  APIRequest,
  PipecatClientOptions,
  TransportConnectionParams,
} from "@pipecat-ai/client-js";
import { PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createTransport,
  type TransportFactory,
  type TransportOptions,
  type TransportType,
} from "@/lib/transports";
import i18n from "@/i18n";

/** Client states from which a new connection attempt may start. */
const CONNECTABLE_STATES: string[] = ["initialized", "disconnected", "error"];

/** 本机回环：不需要 STUN，等它只会拖慢首连。 */
function isLoopbackLocation(): boolean {
  if (typeof window === "undefined") return false;
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    window.location.hostname,
  );
}

function isStunServer(server: RTCIceServer): boolean {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.length > 0 && urls.every((url) => url.startsWith("stun:"));
}

export interface UsePipecatAppOptions {
  /** Defaults to smallwebrtc; changing this rebuilds the client. */
  transportType?: TransportType;
  /** App-owned factory, sync or lazy. Remount to change it. */
  transportFactory?: TransportFactory;
  /** Read at construction; remount to change. */
  transportOptions?: TransportOptions;
  /** Construction options; microphone defaults on and camera off. */
  clientOptions?: Partial<Omit<PipecatClientOptions, "transport">>;
  /** Read per attempt; an APIRequest starts a bot before connecting. */
  connectParams?: TransportConnectionParams | APIRequest;
  /** Start request with optional response transformation; overrides connectParams. */
  startBotParams?: APIRequest;
  /** Transforms the startBot response before it is passed to connect(). */
  startBotResponseTransformer?: (
    response: TransportConnectionParams,
  ) => TransportConnectionParams | Promise<TransportConnectionParams>;
  /** Connect automatically once the client is ready. Default false. */
  connectOnMount?: boolean;
  /** Call client.initDevices() as soon as the client exists. Default false. */
  initDevicesOnMount?: boolean;
  /** Runs before device initialization or connection. */
  onClient?: (client: PipecatClient) => void;
}

export interface UsePipecatAppReturn {
  /** Null until the transport module has loaded and the client is built. */
  client: PipecatClient | null;
  /**
   * Starts the session (startBot flow when configured). No-op unless the
   * client state is initialized, disconnected, or error.
   */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Failure message from transport loading, device init, or connecting —
   * null while healthy. Cleared automatically when connect() retries.
   */
  error: string | null;
  /** Distinguishes identical failures across retries, including batched state updates. */
  errorSequence: number;
  clearError: () => void;
  /** Raw client.startBot() response from the most recent connect. */
  rawStartBotResponse: unknown;
  /** The startBot response after `startBotResponseTransformer` ran. */
  transformedStartBotResponse: unknown;
}

/** Owns the client lifecycle. Only transportType rebuilds it; remount to change construction options. */
export function usePipecatApp(
  options: UsePipecatAppOptions = {},
): UsePipecatAppReturn {
  const { transportType = "smallwebrtc" } = options;

  // Read current options without recreating a live client.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activeClientRef = useRef<PipecatClient | null>(null);
  const connectingRef = useRef<PipecatClient | null>(null);
  const attemptRef = useRef<object | null>(null);

  const [client, setClient] = useState<PipecatClient | null>(null);
  const [errorEvent, setErrorEvent] = useState<{ text: string | null; sequence: number }>({ text: null, sequence: 0 });
  const error = errorEvent.text;
  const setError = useCallback((text: string | null) => {
    setErrorEvent((previous) => ({ text, sequence: previous.sequence + (text === null ? 0 : 1) }));
  }, []);
  const [rawStartBotResponse, setRawStartBotResponse] = useState<unknown>(null);
  const [transformedStartBotResponse, setTransformedStartBotResponse] =
    useState<unknown>(null);

  const startAndConnect = useCallback(async (activeClient: PipecatClient) => {
    if (
      activeClientRef.current !== activeClient ||
      connectingRef.current === activeClient
    )
      return;
    connectingRef.current = activeClient;
    const attempt = {};
    attemptRef.current = attempt;
    const isCurrent = () =>
      activeClientRef.current === activeClient &&
      attemptRef.current === attempt;

    const { connectParams, startBotParams, startBotResponseTransformer } =
      optionsRef.current;
    const activeTransportType =
      optionsRef.current.transportType ?? "smallwebrtc";
    try {
      // SDK connect() does not reject device-init failures; handle them here.
      if (activeClient.needsInit()) {
        await activeClient.initDevices();
        if (!isCurrent()) {
          if (
            activeClientRef.current !== activeClient ||
            attemptRef.current === null
          ) {
            await activeClient.disconnect();
          }
          return;
        }
      }
      if (startBotParams) {
        const response = await activeClient.startBot({
          requestData: {},
          ...startBotParams,
        });
        if (!isCurrent()) return;
        setRawStartBotResponse(response);
        if (
          activeTransportType === "smallwebrtc" &&
          typeof response === "object" &&
          response !== null &&
          "iceConfig" in response
        ) {
          const { iceConfig } = response as {
            iceConfig: { iceServers: RTCIceServer[] };
          };
          // Avoid a type import from an optional transport package.
          const servers = iceConfig.iceServers ?? [];
          (
            activeClient.transport as { iceServers?: RTCIceServer[] }
          ).iceServers = isLoopbackLocation()
            ? servers.filter((server) => !isStunServer(server))
            : servers;
        }
        const transformed = startBotResponseTransformer
          ? await startBotResponseTransformer(response)
          : response;
        if (!isCurrent()) return;
        await activeClient.connect(transformed);
        if (isCurrent()) setTransformedStartBotResponse(transformed);
      } else if (
        connectParams &&
        typeof connectParams === "object" &&
        "endpoint" in connectParams
      ) {
        // Check cancellation between bot startup and transport connection.
        const response = await activeClient.startBot(
          connectParams as APIRequest,
        );
        if (!isCurrent()) return;
        await activeClient.connect(response);
      } else {
        await activeClient.connect(connectParams ?? {});
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(
        i18n.t("errors.startSession", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      await activeClient.disconnect().catch(() => {});
      // 交给调用方收尾（Console 的 onConnectError）：否则首次 /start 或
      // WebRTC 协商失败时，页面不知道这次连接已经结束。
      throw err;
    } finally {
      if (attemptRef.current === attempt) connectingRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let createdClient: PipecatClient | null = null;

    (async () => {
      const { transportOptions, transportFactory, clientOptions } =
        optionsRef.current;
      let transport;
      try {
        transport = transportFactory
          ? await transportFactory(transportOptions)
          : await createTransport(transportType, transportOptions);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (cancelled) return;

      try {
        const pcClient = new PipecatClient({
          enableCam: false,
          enableMic: true,
          ...clientOptions,
          transport,
        });
        createdClient = pcClient;
        activeClientRef.current = pcClient;
        const setupAttempt = {};
        attemptRef.current = setupAttempt;
        setClient(pcClient);
        // Provider errors must surface even when the SDK labels them non-fatal.
        // Do not echo provider payloads (they may include credentials) into UI/logs.
        pcClient.on(RTVIEvent.Error, () => {
          if (activeClientRef.current !== pcClient) return;
          attemptRef.current = null;
          connectingRef.current = null;
          setError(i18n.t("errors.pipelineService"));
          void pcClient.disconnect().catch(() => {});
        });
        optionsRef.current.onClient?.(pcClient);

        if (optionsRef.current.initDevicesOnMount) {
          await pcClient.initDevices();
          if (cancelled || attemptRef.current !== setupAttempt) {
            if (cancelled || attemptRef.current === null) {
              await pcClient.disconnect();
            }
            return;
          }
        }
        if (
          !cancelled &&
          attemptRef.current === setupAttempt &&
          optionsRef.current.connectOnMount
        ) {
          await startAndConnect(pcClient);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          await createdClient?.disconnect().catch(() => {});
        }
      }
    })();

    return () => {
      cancelled = true;
      if (activeClientRef.current === createdClient) {
        activeClientRef.current = null;
        connectingRef.current = null;
        attemptRef.current = null;
      }
      // Cleanup cannot report to an unmounted caller, but must handle rejection.
      void createdClient?.disconnect().catch(() => {});
      setClient(null);
      setError(null);
      setRawStartBotResponse(null);
      setTransformedStartBotResponse(null);
    };
  }, [transportType, startAndConnect]);

  const connect = useCallback(async () => {
    if (!client || !CONNECTABLE_STATES.includes(client.state)) return;
    setError(null);
    await startAndConnect(client);
  }, [client, startAndConnect]);

  const disconnect = useCallback(async () => {
    if (!client) return;
    attemptRef.current = null;
    connectingRef.current = null;
    try {
      await client.disconnect();
    } catch (err) {
      if (activeClientRef.current !== client) return;
      setError(
        i18n.t("errors.disconnect", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, [client]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    client,
    connect,
    disconnect,
    error,
    errorSequence: errorEvent.sequence,
    clearError,
    rawStartBotResponse,
    transformedStartBotResponse,
  };
}
