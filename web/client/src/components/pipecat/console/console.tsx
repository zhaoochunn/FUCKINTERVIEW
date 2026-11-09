"use client";

import type {
  APIRequest,
  Participant,
  PipecatClient,
  PipecatClientOptions,
  TransportConnectionParams,
  TransportState,
} from "@pipecat-ai/client-js";
import { RTVIEvent } from "@pipecat-ai/client-js";
import {
  PipecatClientProvider,
  useConversationContext,
  useRTVIClientEvent,
} from "@pipecat-ai/client-react";
import type { createStore } from "jotai/vanilla";
import {
  BotIcon,
  ChevronsLeftRightEllipsisIcon,
  FilesIcon,
  GaugeIcon,
  InfoIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  useDefaultLayout,
  usePanelRef,
  type LayoutStorage,
} from "react-resizable-panels";

import { BotAudioOutput } from "@/components/pipecat/bot-audio";
import { ConnectButton } from "@/components/pipecat/connect-button";
import { ConsoleAnswerPanel } from "@/components/pipecat/console/answer-panel";
import { ConsoleBotAudioPanel } from "@/components/pipecat/console/bot-audio-panel";
import { ConsoleBotVideoPanel } from "@/components/pipecat/console/bot-video-panel";
import { SmallWebRTCCodecSetter } from "@/components/pipecat/console/codec-setter";
import { ConsoleConversationPanel } from "@/components/pipecat/console/conversation-panel";
import { ConsoleDocumentsPanel } from "@/components/pipecat/console/documents-panel";
import { ConsoleEventsPanel } from "@/components/pipecat/console/events-panel";
import { ConsoleInfoPanel } from "@/components/pipecat/console/info-panel";
import { ConsoleKeypadToggle } from "@/components/pipecat/console/keypad-toggle";
import { LiveConversationPanel } from "@/components/pipecat/console/live-conversation-panel";
import { BrandLogo } from "@/components/brand-logo";
import { ConsoleMetricsPanel } from "@/components/pipecat/console/metrics-panel";
import { useMinWidth } from "@/components/pipecat/console/panel";
import type { ConversationProps } from "@/components/pipecat/conversation";
import type { DTMFKeypadMode } from "@/components/pipecat/dtmf-keypad";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WindowControls } from "@/components/window-controls";
import {
  usePipecatApp,
  type UsePipecatAppReturn,
} from "@/hooks/use-pipecat-app";
import { usePipecatEventStream } from "@/hooks/use-pipecat-event-stream";
import { usePipecatMetricValue } from "@/hooks/use-pipecat-metrics";
import type { LiveMessage } from "@/lib/live-message";
import type {
  TransportFactory,
  TransportOptions,
  TransportType,
} from "@/lib/transports";
import { cn } from "@/lib/utils";

// Connection-URL helpers: resolve the URL the connect button will hit, for
// its hover tooltip.

function extractUrlFromOptions(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const record = options as Record<string, unknown>;
  const requestParams = record.webrtcRequestParams;
  if (typeof requestParams === "object" && requestParams !== null) {
    const endpoint = (requestParams as Record<string, unknown>).endpoint;
    if (typeof endpoint === "string") return endpoint;
  }
  if (typeof record.webrtcUrl === "string") return record.webrtcUrl;
  if (typeof record.connectionUrl === "string") return record.connectionUrl;
  return undefined;
}

function resolveUrl(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

function getConnectionUrl(
  startBotParams?: APIRequest,
  connectParams?: unknown,
  transportOptions?: unknown,
): string | undefined {
  const candidate =
    (typeof startBotParams?.endpoint === "string" && startBotParams.endpoint) ||
    extractUrlFromOptions(connectParams) ||
    extractUrlFromOptions(transportOptions);
  return candidate ? resolveUrl(candidate) : undefined;
}

// The metrics tab and the mobile events tab unmount while inactive. These keep
// their shared stores collecting, so opening either shows the whole session.
function MetricsCollector() {
  usePipecatMetricValue("ttfb");
  return null;
}

function EventStreamCollector() {
  usePipecatEventStream();
  return null;
}

/** Inert storage handed to useDefaultLayout when persistence is off. */
const MEMORY_STORAGE: LayoutStorage = {
  getItem: () => null,
  setItem: () => {},
} as LayoutStorage;

type JotaiStore = ReturnType<typeof createStore>;

/**
 * 首页「开始面试」带过来的自动连接信号只消费一次。React StrictMode 在
 * 开发环境会挂载两次，这个模块级游标保证不会弹出两次系统音频授权。
 */
let lastAutoConnectSignal = 0;

export interface ConsoleProps {
  /**
   * Pane arrangement. "default" is the media / conversation+metrics / info
   * console; "interview" is transcript / answer / metrics, for the live
   * interview page.
   */
  layout?: "default" | "interview";
  /**
   * Store behind conversation, metrics and event state. Defaults to the
   * library-wide store; pass one per page so two consoles never share a
   * transcript.
   */
  jotaiStore?: JotaiStore;
  /**
   * Awaited by the connect button before connecting — the live interview
   * captures system audio here, while the click still counts as a user
   * gesture.
   */
  beforeConnect?: () => Promise<void>;
  /**
   * Interview layout: the candidate's transcript, collected from the second
   * (microphone) session and merged into the left-hand conversation.
   */
  liveConversation?: { messages: LiveMessage[]; interimText?: string };
  /**
   * Bump to request a disconnect, e.g. when the user stops sharing system
   * audio from the browser's own bar.
   */
  disconnectSignal?: number;
  /** Safe message when an external audio source ends. */
  captureError?: string | null;
  /**
   * 首页确认档案后跳过来时，用这个信号让 Console 自动发起一次连接。
   * 值必须递增；同一个值只在第一次挂载时生效（StrictMode 会挂载两次）。
   */
  autoConnectSignal?: number;
  /** 用户主动结束会话时调用（点断开、停止共享系统音频）。 */
  onEnd?: () => void;

  // -- Bootstrap (forwarded to usePipecatApp) --------------------------------
  /** Transport backing the client (default "smallwebrtc"). Match it to transportFactory; codec and ICE handling depend on it. */
  transportType?: TransportType;
  /** Creates your installed transport. Read once; remount to change. Without it, the loader registered for transportType is used. */
  transportFactory?: TransportFactory;
  /** Constructor options for the selected transport. */
  transportOptions?: TransportOptions;
  /** Overrides merged into the PipecatClient constructor. */
  clientOptions?: Partial<PipecatClientOptions>;
  /** Connection params, or an APIRequest (with endpoint) for start-and-connect. */
  connectParams?: TransportConnectionParams | APIRequest;
  /** When set, connecting starts a bot via startBot() first. */
  startBotParams?: APIRequest;
  /** Transforms the startBot response before connecting. */
  startBotResponseTransformer?: (
    response: TransportConnectionParams,
  ) => TransportConnectionParams | Promise<TransportConnectionParams>;
  /** Connect automatically once the client is ready. Default false. */
  connectOnMount?: boolean;
  /** Initialize devices as soon as the client exists. Default true. */
  initDevicesOnMount?: boolean;
  /** Fired once per created client, before device init or connect. */
  onClient?: (client: PipecatClient) => void;

  // -- Header ---------------------------------------------------------------
  /** Header title (default "Pipecat Console"); hidden on narrow viewports. */
  titleText?: string;
  /** Replaces the app logo. */
  logo?: React.ReactNode;
  /** Hides the logo entirely. Default false. */
  noLogo?: boolean;
  /**
   * Extra header content rendered before the connect button — e.g. your
   * app's theme toggle. Rendered only when provided.
   */
  headerSlot?: React.ReactNode;
  /**
   * Extra header content rendered at the very left, before the logo —
   * e.g. the app's narrow-screen page switcher.
   */
  leadingSlot?: React.ReactNode;
  /**
   * 用户点「断开」并且连接真的收掉之后触发——比如面试页用它回首页。
   * 系统音频被外部结束（disconnectSignal）走的不是这条路。
   */
  onDisconnected?: () => void;
  /** 连接失败（授权取消、信令报错）时触发，带原始错误。 */
  onConnectError?: (error: unknown) => void;

  // -- Region toggles (all default false unless noted) -----------------------
  noUserAudio?: boolean;
  noUserVideo?: boolean;
  noScreenControl?: boolean;
  /** Hides the DTMF keypad button. */
  noDTMF?: boolean;
  /** Hides the text input under the transcript. */
  noTextInput?: boolean;
  /** Disables bot audio playback entirely (also hides its volume control). */
  noAudioOutput?: boolean;
  /** Hides the bot audio pane. */
  noBotAudio?: boolean;
  /** Hides the volume control in the bot audio pane header. */
  noBotAudioControls?: boolean;
  /** Hides the bot video pane. Default false. */
  noBotVideo?: boolean;
  noConversation?: boolean;
  noMetrics?: boolean;
  /** Hides the events strip. */
  noEvents?: boolean;
  noStatusInfo?: boolean;
  noSessionInfo?: boolean;
  /** Interview layout: start the metrics pane collapsed to its icon strip. */
  collapseMetricsPanel?: boolean;

  // -- Behavior --------------------------------------------------------------
  /** How the DTMF keypad dispatches presses (default "buffered"). */
  keypadMode?: DTMFKeypadMode;
  /** Overrides merged onto the Conversation (labels, renderers, …). */
  conversationProps?: Partial<ConversationProps>;
  /** Preferred audio codec (smallwebrtc only). */
  audioCodec?: string;
  /** Preferred video codec (smallwebrtc only). */
  videoCodec?: string;
  /** Start with the info pane collapsed. Default false. */
  collapseInfoPanel?: boolean;
  /** Start with the bot media pane collapsed. Default false. */
  collapseMediaPanel?: boolean;
  /** Start with the events strip collapsed. Default false. */
  collapseEventsPanel?: boolean;
  /**
   * Persist the resizable layout under this key (localStorage). Off when
   * unset.
   */
  layoutPersistenceKey?: string;

  // -- Callbacks -------------------------------------------------------------
  /** Fired on every transport state change. */
  onConnectionStateChange?: (state: TransportState) => void;
  /** Fired for RTVI server messages. */
  onServerMessage?: (data: unknown) => void;
  /** Hands you the transcript's injectMessage function once available. */
  onInjectMessage?: (
    inject: ReturnType<typeof useConversationContext>["injectMessage"],
  ) => void;

  className?: string;
}

/**
 * Full-page Pipecat debugging console: header with connect flow, resizable
 * bot-media / conversation+metrics / info panes over an events strip, and a
 * single-tree mobile layout using bottom tabs.
 *
 * The console builds its own client via usePipecatApp and renders its own
 * PipecatClientProvider — do not nest it inside another provider. Supply
 * the transport with `transportFactory` or `registerTransport`; load
 * failures surface in the error banner.
 */
export function Console(props: ConsoleProps) {
  const {
    transportType = "smallwebrtc",
    transportFactory,
    transportOptions,
    clientOptions,
    connectParams,
    startBotParams,
    startBotResponseTransformer,
    connectOnMount = false,
    initDevicesOnMount = true,
    onClient,
    className,
  } = props;

  const app = usePipecatApp({
    transportType,
    transportFactory,
    transportOptions,
    clientOptions,
    connectParams,
    startBotParams,
    startBotResponseTransformer,
    connectOnMount,
    initDevicesOnMount,
    onClient,
  });
  const { t } = useTranslation();

  // 挂载时的设备初始化 / 传输创建失败不会走 handleConnect（用户还没点
  // 连接），但页面同样锁着。app.error 一旦出现就交给调用方收尾。
  // 放在这里而不是 ConsoleShell：client 创建失败时 Shell 还没挂载。
  const reportedAppError = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!app.error || app.error === reportedAppError.current) return;
    reportedAppError.current = app.error;
    props.onConnectError?.(new Error(app.error));
  }, [app.error, props.onConnectError]);

  if (!app.client) {
    return (
      <div
        data-slot="console"
        data-state={app.error ? "error" : "loading"}
        className={cn(
          "bg-background flex h-full min-h-64 items-center justify-center p-4",
          className,
        )}
      >
        {app.error ? (
          <Alert variant="destructive" className="max-w-lg">
            <AlertTitle>{t("console.failedToStart")}</AlertTitle>
            <AlertDescription>{app.error}</AlertDescription>
          </Alert>
        ) : (
          <Spinner className="size-6" />
        )}
      </div>
    );
  }

  return (
    <PipecatClientProvider client={app.client} jotaiStore={props.jotaiStore}>
      <TooltipProvider>
        <ConsoleShell {...props} app={app} />
      </TooltipProvider>
      {!props.noAudioOutput && <BotAudioOutput />}
      {!props.noMetrics && <MetricsCollector />}
      {!props.noEvents && <EventStreamCollector />}
      {transportType === "smallwebrtc" && (
        <SmallWebRTCCodecSetter
          audioCodec={props.audioCodec}
          videoCodec={props.videoCodec}
        />
      )}
    </PipecatClientProvider>
  );
}

function ConsoleShell({
  app,
  layout = "default",
  beforeConnect,
  liveConversation,
  disconnectSignal,
  captureError,
  autoConnectSignal,
  onEnd,
  transportOptions,
  connectParams,
  startBotParams,
  titleText = "Pipecat Console",
  logo,
  noLogo = false,
  headerSlot,
  leadingSlot,
  onDisconnected,
  onConnectError,
  noUserAudio = false,
  noUserVideo = false,
  noScreenControl = false,
  noDTMF = false,
  noTextInput = false,
  noAudioOutput = false,
  noBotAudio = false,
  noBotAudioControls = false,
  noBotVideo = false,
  noConversation = false,
  noMetrics = false,
  noEvents = false,
  noStatusInfo = false,
  noSessionInfo = false,
  collapseMetricsPanel = false,
  keypadMode = "buffered",
  conversationProps,
  collapseInfoPanel = false,
  collapseMediaPanel = false,
  collapseEventsPanel = false,
  layoutPersistenceKey,
  onConnectionStateChange,
  onServerMessage,
  onInjectMessage,
  className,
}: ConsoleProps & { app: UsePipecatAppReturn }) {
  const { t } = useTranslation();
  // Three resizable columns need about 1024px; narrower screens get tabs.
  const isDesktop = useMinWidth(1024);
  const isInterviewLayout = layout === "interview";

  // -- Session facts collected from RTVI events ------------------------------
  const [participantId, setParticipantId] = React.useState<string>();
  const [sessionId, setSessionId] = React.useState<string>();

  useRTVIClientEvent(
    RTVIEvent.ParticipantConnected,
    React.useCallback((participant: Participant) => {
      if (participant.local) setParticipantId(participant.id);
    }, []),
  );
  // Belt and braces for transports that never fire ParticipantConnected.
  useRTVIClientEvent(
    RTVIEvent.TrackStarted,
    React.useCallback((_track: MediaStreamTrack, participant?: Participant) => {
      if (participant?.local && participant.id) {
        setParticipantId(participant.id);
      }
    }, []),
  );
  useRTVIClientEvent(
    RTVIEvent.BotStarted,
    React.useCallback((response: unknown) => {
      const id = (response as { sessionId?: string } | null)?.sessionId;
      if (typeof id === "string") setSessionId(id);
    }, []),
  );

  const onServerMessageRef = React.useRef(onServerMessage);
  onServerMessageRef.current = onServerMessage;
  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    React.useCallback((data: unknown) => {
      onServerMessageRef.current?.(data);
    }, []),
  );

  const onConnectionStateChangeRef = React.useRef(onConnectionStateChange);
  onConnectionStateChangeRef.current = onConnectionStateChange;
  useRTVIClientEvent(
    RTVIEvent.TransportStateChanged,
    React.useCallback((state: TransportState) => {
      onConnectionStateChangeRef.current?.(state);
    }, []),
  );

  const { injectMessage } = useConversationContext();
  const onInjectMessageRef = React.useRef(onInjectMessage);
  onInjectMessageRef.current = onInjectMessage;
  React.useEffect(() => {
    onInjectMessageRef.current?.(injectMessage);
  }, [injectMessage]);

  // -- Region math -----------------------------------------------------------
  const noBotArea = noBotAudio && noBotVideo;
  const noConversationPanel = noConversation && noMetrics;
  const noDevices = noUserAudio && noUserVideo && noScreenControl;
  const noInfoPanel = noStatusInfo && noDevices && noSessionInfo;

  // react-resizable-panels v4 reads bare numbers as pixels, so every size
  // below is a percentage string. Conversation takes whatever the side panes
  // leave so the horizontal defaults always sum to 100.
  const mediaDefaultSize = noBotArea ? 0 : collapseMediaPanel ? 8 : 26;
  const infoDefaultSize = noInfoPanel ? 0 : collapseInfoPanel ? 4 : 27;
  const conversationDefaultSize = 100 - mediaDefaultSize - infoDefaultSize;

  // -- Resizable layout state ------------------------------------------------
  const persist = Boolean(layoutPersistenceKey);
  const storage = persist ? undefined : MEMORY_STORAGE;
  const verticalLayout = useDefaultLayout({
    id: `${layoutPersistenceKey ?? "pipecat-console"}:v`,
    storage,
  });
  const horizontalLayout = useDefaultLayout({
    id: `${layoutPersistenceKey ?? "pipecat-console"}:${isInterviewLayout ? "interview" : "h"}`,
    storage,
  });

  const mediaPanelRef = usePanelRef();
  const infoPanelRef = usePanelRef();
  const metricsPanelRef = usePanelRef();
  const eventsPanelRef = usePanelRef();
  const [isMediaCollapsed, setIsMediaCollapsed] =
    React.useState(collapseMediaPanel);
  const [isInfoCollapsed, setIsInfoCollapsed] =
    React.useState(collapseInfoPanel);
  const [isMetricsCollapsed, setIsMetricsCollapsed] =
    React.useState(collapseMetricsPanel);
  const [isEventsCollapsed, setIsEventsCollapsed] =
    React.useState(collapseEventsPanel);
  const [connectError, setConnectError] = React.useState<string | null>(null);
  const connectAttempt = React.useRef<object | null>(null);
  React.useEffect(() => () => { connectAttempt.current = null; }, []);

  // The live page bumps this when system-audio sharing ends outside the app.
  const handledDisconnectSignal = React.useRef(0);
  React.useEffect(() => {
    if (!disconnectSignal || disconnectSignal === handledDisconnectSignal.current)
      return;
    handledDisconnectSignal.current = disconnectSignal;
    connectAttempt.current = null;
    // Source loss is not an explicit user completion. Unlock even if setup never connected.
    if (captureError) onConnectError?.(new Error(captureError));
    void app.disconnect();
  }, [app, disconnectSignal, captureError, onConnectError]);

  const connectionUrl = getConnectionUrl(
    startBotParams,
    connectParams,
    transportOptions,
  );

  // -- Shared panel elements (instantiated once per render, one branch) ------
  const mediaStack = (collapsed: boolean) =>
    noBotArea ? null : (
      <div className="flex h-full min-h-0 flex-col gap-2">
        {!noBotAudio && (
          <ConsoleBotAudioPanel
            collapsed={collapsed}
            noControls={noBotAudioControls || noAudioOutput}
            className={noBotVideo ? undefined : "flex-1"}
          />
        )}
        {!noBotVideo && (
          <ConsoleBotVideoPanel
            collapsed={collapsed}
            className={noBotAudio ? undefined : "flex-1"}
          />
        )}
      </div>
    );

  const conversationPanel = noConversationPanel ? null : (
    <ConsoleConversationPanel
      noConversation={noConversation}
      noMetrics={noMetrics}
      noTextInput={noTextInput}
      conversationProps={conversationProps}
      className="h-full"
    />
  );

  const infoPanel = (collapsed: boolean) =>
    noInfoPanel ? null : (
      <ConsoleInfoPanel
        noStatusInfo={noStatusInfo}
        noUserAudio={noUserAudio}
        noUserVideo={noUserVideo}
        noScreenControl={noScreenControl}
        noSessionInfo={noSessionInfo}
        sessionId={sessionId}
        participantId={participantId}
        collapsed={collapsed}
        className="h-full"
      />
    );

  // -- Interview layout panes: transcript / answer / metrics -----------------
  const interviewConversationPanel = (
    <LiveConversationPanel
      extraMessages={liveConversation?.messages}
      interimText={liveConversation?.interimText}
      noTextInput={noTextInput}
      className="h-full"
    />
  );

  const answerPanel = (
    <ConsoleAnswerPanel
      conversationProps={conversationProps}
      className="h-full"
    />
  );

  const metricsPanel = (collapsed: boolean) => (
    <ConsoleMetricsPanel collapsed={collapsed} className="h-full" />
  );

  const eventsPanel = (collapsed: boolean) =>
    noEvents ? null : (
      <ConsoleEventsPanel collapsed={collapsed} className="h-full" />
    );

  // 实时面试的底部条换成资料展示；事件日志只留给模拟面试的默认布局。
  const documentsPanel = (collapsed: boolean) =>
    noEvents ? null : (
      <ConsoleDocumentsPanel collapsed={collapsed} className="h-full" />
    );

  const toggleInfoPanel = () => {
    const handle = infoPanelRef.current;
    if (!handle) return;
    if (handle.isCollapsed()) handle.expand();
    else handle.collapse();
  };

  const handleConnect = async () => {
    // beforeConnect can hold a system-audio picker open for a while; without
    // this guard a second click would start a second capture and session.
    if (connectAttempt.current) return;
    const attempt = {};
    connectAttempt.current = attempt;
    setConnectError(null);
    try {
      await beforeConnect?.();
      if (connectAttempt.current !== attempt) return;
      await app.connect();
    } catch (error) {
      if (connectAttempt.current !== attempt) return;
      setConnectError(error instanceof Error ? error.message : String(error));
      onConnectError?.(error);
    } finally {
      if (connectAttempt.current === attempt) {
        connectAttempt.current = null;
      }
    }
  };

  const connectButton = (
    <ConnectButton
      size="sm"
      onConnect={handleConnect}
      onDisconnect={() => {
        connectAttempt.current = null;
        onEnd?.();
        void Promise.resolve(app.disconnect()).finally(() =>
          onDisconnected?.()
        );
      }}
    />
  );

  // 首页确认档案后跳过来：等 Console 真正挂载、client 就绪，再发起连接。
  // beforeConnect 里的系统音频选择器仍然在浏览器允许的临时用户激活窗口内。
  const handleConnectRef = React.useRef(handleConnect);
  handleConnectRef.current = handleConnect;
  React.useEffect(() => {
    if (!autoConnectSignal || autoConnectSignal <= lastAutoConnectSignal) return;
    lastAutoConnectSignal = autoConnectSignal;
    void handleConnectRef.current();
  }, [autoConnectSignal]);

  const errorText = connectError ?? captureError ?? app.error;

  return (
    <div
      data-slot="console"
      data-state="ready"
      className={cn(
        "bg-background text-foreground flex h-full min-h-0 flex-col",
        className,
      )}
    >
      <header
        data-slot="console-header"
        className="app-drag app-page-header flex h-12 items-center gap-2 border-b px-3"
      >
        {leadingSlot && (
          <div className="flex shrink-0 items-center gap-1">{leadingSlot}</div>
        )}
        {!noLogo && (
          <div className="flex shrink-0 items-center">
            {logo ?? <BrandLogo size={20} />}
          </div>
        )}
        {titleText && (
          <strong className="hidden min-w-0 truncate text-sm md:block">
            {titleText}
          </strong>
        )}
        <div className="app-no-drag ml-auto flex min-w-0 items-center justify-end gap-1">
          {/* Slot content may shrink; the console's own controls never do. */}
          {headerSlot && (
            <div className="flex min-w-0 items-center gap-1">{headerSlot}</div>
          )}
          {!noDTMF && <ConsoleKeypadToggle mode={keypadMode} />}
          {!isInterviewLayout && !noInfoPanel && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden lg:inline-flex"
              aria-label={
                isInfoCollapsed ? t("header.expandInfo") : t("header.collapseInfo")
              }
              onClick={toggleInfoPanel}
            >
              {isInfoCollapsed ? (
                <PanelLeftCloseIcon />
              ) : (
                <PanelRightCloseIcon />
              )}
            </Button>
          )}
          {connectionUrl && !isInterviewLayout ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                {connectButton}
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                {connectionUrl}
              </TooltipContent>
            </Tooltip>
          ) : (
            connectButton
          )}
        </div>
        <WindowControls />
      </header>

      {errorText && (
        <Alert
          variant="destructive"
          className="animate-in fade-in m-2 duration-300"
        >
          <AlertTitle>{t("console.sessionError")}</AlertTitle>
          <AlertDescription>{errorText}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("header.dismissError")}
              onClick={() => {
                app.clearError();
                setConnectError(null);
              }}
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="min-h-0 flex-1 p-2">
        {isInterviewLayout ? (
          isDesktop ? (
            <ResizablePanelGroup
              orientation="vertical"
              defaultLayout={verticalLayout.defaultLayout}
              onLayoutChanged={verticalLayout.onLayoutChanged}
              className="gap-2"
            >
              {/* 主区域最低压到 28%，下面「其他资料」可以拉到七成高度看 PDF。 */}
              <ResizablePanel id="main" defaultSize="70%" minSize="28%">
                <ResizablePanelGroup
                  orientation="horizontal"
                  defaultLayout={horizontalLayout.defaultLayout}
                  onLayoutChanged={horizontalLayout.onLayoutChanged}
                  className="gap-2"
                >
                  <ResizablePanel
                    id="conversation"
                    defaultSize="36%"
                    minSize="22%"
                  >
                    <div className="h-full p-px">
                      {interviewConversationPanel}
                    </div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="answer" defaultSize="34%" minSize="22%">
                    <div className="h-full p-px">{answerPanel}</div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="metrics"
                    defaultSize={collapseMetricsPanel ? 56 : "30%"}
                    minSize="14%"
                    collapsible
                    collapsedSize={56}
                    panelRef={metricsPanelRef}
                    onResize={() =>
                      setIsMetricsCollapsed(
                        metricsPanelRef.current?.isCollapsed() ?? false,
                      )
                    }
                  >
                    <div className="h-full p-px">
                      {metricsPanel(isMetricsCollapsed)}
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
              {!noEvents && <ResizableHandle withHandle />}
              {!noEvents && (
                <ResizablePanel
                  id="documents"
                  defaultSize={collapseEventsPanel ? "6%" : "30%"}
                  minSize="7%"
                  collapsible
                  collapsedSize="6%"
                  panelRef={eventsPanelRef}
                  onResize={() =>
                    setIsEventsCollapsed(
                      eventsPanelRef.current?.isCollapsed() ?? false,
                    )
                  }
                >
                  <div className="h-full p-px">
                    {documentsPanel(isEventsCollapsed)}
                  </div>
                </ResizablePanel>
              )}
            </ResizablePanelGroup>
          ) : (
            <Tabs
              defaultValue="conversation"
              className="flex h-full min-h-0 flex-col"
            >
              <TabsContent
                value="conversation"
                keepMounted
                className="min-h-0 flex-1 data-[hidden]:hidden"
              >
                {interviewConversationPanel}
              </TabsContent>
              <TabsContent
                value="answer"
                keepMounted
                className="min-h-0 flex-1 data-[hidden]:hidden"
              >
                {answerPanel}
              </TabsContent>
              <TabsContent value="metrics" className="min-h-0 flex-1">
                {metricsPanel(false)}
              </TabsContent>
              {!noEvents && (
                <TabsContent value="documents" className="min-h-0 flex-1">
                  {documentsPanel(false)}
                </TabsContent>
              )}
              <TabsList className="mt-2 w-full">
                <TabsTrigger
                  value="conversation"
                  aria-label={t("console.tabs.conversation")}
                >
                  <MessagesSquareIcon />
                </TabsTrigger>
                <TabsTrigger
                  value="answer"
                  aria-label={t("console.tabs.answer")}
                >
                  <SparklesIcon />
                </TabsTrigger>
                <TabsTrigger
                  value="metrics"
                  aria-label={t("console.tabs.metrics")}
                >
                  <GaugeIcon />
                </TabsTrigger>
                {!noEvents && (
                  <TabsTrigger
                    value="documents"
                    aria-label={t("console.tabs.documents")}
                  >
                    <FilesIcon />
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
          )
        ) : isDesktop ? (
          <ResizablePanelGroup
            orientation="vertical"
            defaultLayout={verticalLayout.defaultLayout}
            onLayoutChanged={verticalLayout.onLayoutChanged}
            className="gap-2"
          >
            <ResizablePanel id="main" defaultSize="70%" minSize="50%">
              <ResizablePanelGroup
                orientation="horizontal"
                defaultLayout={horizontalLayout.defaultLayout}
                onLayoutChanged={horizontalLayout.onLayoutChanged}
                className="gap-2"
              >
                {!noBotArea && (
                  <ResizablePanel
                    id="media"
                    defaultSize={`${mediaDefaultSize}%`}
                    minSize="10%"
                    maxSize="30%"
                    collapsible
                    collapsedSize="8%"
                    panelRef={mediaPanelRef}
                    onResize={() =>
                      setIsMediaCollapsed(
                        mediaPanelRef.current?.isCollapsed() ?? false,
                      )
                    }
                  >
                    {/* p-px keeps each card's ring inside the panel's scroll box, which clips it. */}
                    <div className="h-full p-px">
                      {mediaStack(isMediaCollapsed)}
                    </div>
                  </ResizablePanel>
                )}
                {!noBotArea && (!noConversationPanel || !noInfoPanel) && (
                  <ResizableHandle withHandle />
                )}
                {!noConversationPanel && (
                  <ResizablePanel
                    id="conversation"
                    defaultSize={`${conversationDefaultSize}%`}
                    minSize="30%"
                  >
                    <div className="h-full p-px">{conversationPanel}</div>
                  </ResizablePanel>
                )}
                {!noConversationPanel && !noInfoPanel && (
                  <ResizableHandle withHandle />
                )}
                {!noInfoPanel && (
                  <ResizablePanel
                    id="info"
                    defaultSize={`${infoDefaultSize}%`}
                    minSize="15%"
                    collapsible
                    collapsedSize="4%"
                    panelRef={infoPanelRef}
                    onResize={() =>
                      setIsInfoCollapsed(
                        infoPanelRef.current?.isCollapsed() ?? false,
                      )
                    }
                  >
                    <div className="h-full p-px">
                      {infoPanel(isInfoCollapsed)}
                    </div>
                  </ResizablePanel>
                )}
              </ResizablePanelGroup>
            </ResizablePanel>
            {!noEvents && <ResizableHandle withHandle />}
            {!noEvents && (
              <ResizablePanel
                id="events"
                defaultSize={collapseEventsPanel ? "6%" : "30%"}
                minSize="7%"
                collapsible
                collapsedSize="6%"
                panelRef={eventsPanelRef}
                onResize={() =>
                  setIsEventsCollapsed(
                    eventsPanelRef.current?.isCollapsed() ?? false,
                  )
                }
              >
                <div className="h-full p-px">
                  {eventsPanel(isEventsCollapsed)}
                </div>
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
        ) : (
          <Tabs
            defaultValue={
              !noConversationPanel
                ? "conversation"
                : !noBotArea
                  ? "bot"
                  : !noInfoPanel
                    ? "info"
                    : "events"
            }
            className="flex h-full min-h-0 flex-col"
          >
            {!noBotArea && (
              <TabsContent value="bot" className="min-h-0 flex-1">
                {mediaStack(false)}
              </TabsContent>
            )}
            {!noConversationPanel && (
              <TabsContent
                value="conversation"
                keepMounted
                className="min-h-0 flex-1 data-[hidden]:hidden"
              >
                {conversationPanel}
              </TabsContent>
            )}
            {!noInfoPanel && (
              <TabsContent value="info" className="min-h-0 flex-1">
                {infoPanel(false)}
              </TabsContent>
            )}
            {!noEvents && (
              <TabsContent value="events" className="min-h-0 flex-1">
                {eventsPanel(false)}
              </TabsContent>
            )}
            <TabsList className="mt-2 w-full">
              {!noConversationPanel && (
                <TabsTrigger value="conversation" aria-label={t("console.tabs.conversation")}>
                  <MessagesSquareIcon />
                </TabsTrigger>
              )}
              {!noBotArea && (
                <TabsTrigger value="bot" aria-label={t("console.tabs.botMedia")}>
                  <BotIcon />
                </TabsTrigger>
              )}
              {!noInfoPanel && (
                <TabsTrigger value="info" aria-label={t("console.tabs.info")}>
                  <InfoIcon />
                </TabsTrigger>
              )}
              {!noEvents && (
                <TabsTrigger value="events" aria-label={t("console.tabs.events")}>
                  <ChevronsLeftRightEllipsisIcon />
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>
        )}
      </div>
    </div>
  );
}
