"use client";

import { FolderOpenIcon, SettingsIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { MacOSPermissions } from "@/components/macos-permissions";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LANGUAGES, setLanguage, type AppLanguage } from "@/i18n";
import {
  fetchStorage,
  pickFolder,
  saveModelDir,
  saveStorage,
} from "@/lib/materials";
import { qaStats, reindexQa, type QaStats } from "@/lib/qa";
import type { ThemeMode } from "@/lib/theme";
import {
  ASR_PROVIDERS,
  fetchSettings,
  findProvider,
  LLM_PROVIDERS,
  saveSettings,
  type AppSettings,
  type ProviderMeta,
} from "@/lib/settings";

type Section = "asr" | "llm" | "embedding";
type Status = "idle" | "loading" | "saving" | "saved" | "error";

/** 表单规范见 web/client/FORM_SPEC.md：两列等宽、gap-3、控件统一 h-8。 */
const FORM_GRID = "grid gap-3 sm:grid-cols-2";

const THEME_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: "light", labelKey: "settings.theme.light" },
  { value: "dark", labelKey: "settings.theme.dark" },
  { value: "system", labelKey: "settings.theme.system" },
];

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`grid min-w-0 gap-1.5 ${className ?? ""}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** 开关类设置：标题和开关同一行，标签可点。以后新增开关也用它。 */
function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-8 items-center justify-between gap-3">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

function ProviderSelect({
  providers,
  value,
  onChange,
}: {
  providers: ProviderMeta[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const items = providers.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange(String(next))}
    >
      <SelectTrigger className="h-8 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SettingsDialog({
  open,
  onClose,
  theme,
  onThemeChange,
  captureMic,
  onCaptureMicChange,
  contentProtection = false,
  onContentProtectionChange,
  contentProtectionSupported = false,
}: {
  open: boolean;
  onClose: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  captureMic: boolean;
  onCaptureMicChange: (value: boolean) => void;
  contentProtection?: boolean;
  onContentProtectionChange?: (value: boolean) => void;
  contentProtectionSupported?: boolean;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"general" | "models">("general");
  const [storageDir, setStorageDir] = useState("");
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const [storageFailed, setStorageFailed] = useState(false);
  const [modelDir, setModelDir] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [modelFailed, setModelFailed] = useState(false);
  const [qaStatus, setQaStatus] = useState<QaStats | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const { t, i18n } = useTranslation();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setMessage("");
    fetchSettings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setStatus("idle");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStatus("error");
        setMessage(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStorageMessage("");
    setStorageFailed(false);
    fetchStorage()
      .then((info) => {
        if (cancelled) return;
        setStorageDir(info.dataDir);
        setModelDir(info.modelDirCustom ? info.modelDir ?? "" : "");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStorageFailed(true);
        setStorageMessage(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const applyStorage = useCallback(async () => {
    const value = storageDir.trim();
    if (!value) return;
    setStorageBusy(true);
    setStorageMessage("");
    setStorageFailed(false);
    try {
      const info = await saveStorage(value, true);
      setStorageDir(info.dataDir);
      setModelDir(info.modelDirCustom ? info.modelDir ?? "" : "");
      setStorageMessage(t("settings.storage.saved"));
    } catch (error) {
      setStorageFailed(true);
      setStorageMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStorageBusy(false);
    }
  }, [storageDir, t]);

  const pickStorageDir = useCallback(async () => {
    try {
      const path = await pickFolder(storageDir);
      if (path) setStorageDir(path);
    } catch (error) {
      setStorageFailed(true);
      setStorageMessage(error instanceof Error ? error.message : String(error));
    }
  }, [storageDir]);

  const pickModelDir = useCallback(async () => {
    try {
      const path = await pickFolder(modelDir);
      if (path) setModelDir(path);
    } catch (error) {
      setModelFailed(true);
      setModelMessage(error instanceof Error ? error.message : String(error));
    }
  }, [modelDir]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    qaStats()
      .then((data) => {
        if (!cancelled) setQaStatus(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const applyModelDir = useCallback(async () => {
    // 空值表示恢复「跟随数据目录」，不是「不修改」。
    const value = modelDir.trim();
    setModelBusy(true);
    setModelMessage("");
    setModelFailed(false);
    try {
      await saveModelDir(value);
      setModelDir(value);
      setModelMessage(t("settings.modelDir.saved"));
    } catch (error) {
      setModelFailed(true);
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setModelBusy(false);
    }
  }, [modelDir, t]);

  const rebuildIndex = useCallback(async () => {
    setRebuilding(true);
    try {
      await reindexQa("all");
      // 队列是异步的，状态稍后再取一次。
      window.setTimeout(() => {
        void qaStats().then(setQaStatus).catch(() => undefined);
      }, 1500);
    } catch (error) {
      setModelFailed(true);
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRebuilding(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const patch = useCallback((section: Section, key: string, value: string) => {
    setSettings((current) => {
      if (!current) return current;
      return {
        ...current,
        [section]: { ...current[section], [key]: value },
      } as AppSettings;
    });
    setStatus("idle");
    setMessage("");
  }, []);

  // 换供应商时把模型相关字段清空：不替用户预填，让他按选中的供应商自己填。
  const changeAsrProvider = useCallback((provider: string) => {
    if (!findProvider(ASR_PROVIDERS, provider)) return;
    setSettings((current) =>
      current
        ? {
            ...current,
            asr: { ...current.asr, provider, model: "", base_url: "" },
          }
        : current
    );
    setStatus("idle");
    setMessage("");
  }, []);

  const changeLlmProvider = useCallback((provider: string) => {
    if (!findProvider(LLM_PROVIDERS, provider)) return;
    setSettings((current) =>
      current
        ? {
            ...current,
            llm: { ...current.llm, provider, model: "", base_url: "" },
          }
        : current
    );
    setStatus("idle");
    setMessage("");
  }, []);

  const onSave = useCallback(async () => {
    if (!settings) return;
    setStatus("saving");
    try {
      const saved = await saveSettings(settings);
      setSettings(saved);
      setStatus("saved");
      setMessage(t("settings.saved"));
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [settings, t]);

  if (!open) return null;

  const showLlmBaseUrl = !!settings && settings.llm.provider !== "anthropic";
  const showAsrBaseUrl = !!settings && settings.asr.provider !== "deepgram";
  const currentLanguage: AppLanguage = i18n.language.startsWith("en")
    ? "en"
    : "zh";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        className="flex h-[600px] max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <SettingsIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("settings.title")}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("settings.close")}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "general" | "models")}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 border-b border-border px-4 pt-2">
            <TabsList variant="line" className="gap-6">
              <TabsTrigger value="general">
                {t("settings.tabs.general")}
              </TabsTrigger>
              <TabsTrigger value="models">
                {t("settings.tabs.models")}
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="min-h-0 flex-1" contentClassName="p-4">
            <TabsContent value="general" className="grid max-w-md gap-3">
              <Field label={t("settings.fields.appLanguage")}>
                <Select
                  items={LANGUAGES.map(({ value, label }) => ({
                    value,
                    label,
                  }))}
                  value={currentLanguage}
                  onValueChange={(next) =>
                    setLanguage(String(next) as AppLanguage)
                  }
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {LANGUAGES.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label={t("settings.fields.theme")}>
                <Select
                  items={THEME_OPTIONS.map(({ value, labelKey }) => ({
                    value,
                    label: t(labelKey),
                  }))}
                  value={theme}
                  onValueChange={(next) =>
                    onThemeChange(String(next) as ThemeMode)
                  }
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {THEME_OPTIONS.map(({ value, labelKey }) => (
                      <SelectItem key={value} value={value}>
                        {t(labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <SwitchRow
                label={t("settings.fields.captureMic")}
                checked={captureMic}
                onChange={onCaptureMicChange}
              />

              <MacOSPermissions />

              {contentProtectionSupported && onContentProtectionChange && (
                <div className="grid gap-1.5">
                  <SwitchRow
                    label={t("settings.fields.contentProtection")}
                    checked={contentProtection}
                    onChange={onContentProtectionChange}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("settings.contentProtection.hint")}
                  </p>
                </div>
              )}

              <Separator className="my-1" />

              <div className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settings.fields.dataDir")}
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    value={storageDir}
                    placeholder="config"
                    spellCheck={false}
                    onChange={(event) => setStorageDir(event.target.value)}
                    className="h-8 min-w-0 flex-1"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon"
                          variant="outline"
                          aria-label={t("settings.storage.pick")}
                          disabled={storageBusy}
                          onClick={() => void pickStorageDir()}
                        />
                      }
                    >
                      <FolderOpenIcon />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {t("settings.storage.pick")}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="outline"
                    className="h-8"
                    disabled={storageBusy || !storageDir.trim()}
                    onClick={() => void applyStorage()}
                  >
                    {storageBusy && <Spinner className="size-3.5" />}
                    {t("settings.storage.apply")}
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.storage.hint")}
                </p>
                {storageMessage && (
                  <span
                    className={`text-xs ${
                      storageFailed
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {storageMessage}
                  </span>
                )}
              </div>

              <div className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settings.fields.modelDir")}
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    value={modelDir}
                    placeholder={t("settings.modelDir.follow")}
                    spellCheck={false}
                    onChange={(event) => setModelDir(event.target.value)}
                    className="h-8 min-w-0 flex-1"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon"
                          variant="outline"
                          aria-label={t("settings.storage.pick")}
                          disabled={modelBusy}
                          onClick={() => void pickModelDir()}
                        />
                      }
                    >
                      <FolderOpenIcon />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {t("settings.storage.pick")}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="outline"
                    className="h-8"
                    disabled={modelBusy}
                    onClick={() => void applyModelDir()}
                  >
                    {modelBusy && <Spinner className="size-3.5" />}
                    {t("settings.storage.apply")}
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.modelDir.hint")}
                </p>
                {modelMessage && (
                  <span
                    className={`text-xs ${
                      modelFailed ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {modelMessage}
                  </span>
                )}
              </div>
            </TabsContent>

            <TabsContent value="models">
              {status === "loading" || !settings ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  {status === "error" ? (
                    <span className="text-destructive">{message}</span>
                  ) : (
                    <>
                      <Spinner /> {t("settings.loading")}
                    </>
                  )}
                </div>
              ) : (
                <div className="grid gap-6">
                  <section className="grid gap-3" data-slot="settings-section">
                    <h3 className="text-sm font-semibold">
                      {t("settings.sections.asr")}
                    </h3>
                    <Field label={t("settings.fields.provider")}>
                      <ProviderSelect
                        providers={ASR_PROVIDERS}
                        value={settings.asr.provider}
                        onChange={changeAsrProvider}
                      />
                    </Field>

                    <div className={FORM_GRID}>
                      <Field label={t("settings.fields.model")}>
                        <Input
                          value={settings.asr.model}
                          placeholder="qwen3-asr-flash"
                          onChange={(event) =>
                            patch("asr", "model", event.target.value)
                          }
                        />
                      </Field>
                      <Field label={t("settings.fields.asrLanguage")}>
                        <Input
                          value={settings.asr.language}
                          placeholder="zh"
                          onChange={(event) =>
                            patch("asr", "language", event.target.value)
                          }
                        />
                      </Field>
                    </div>

                    {showAsrBaseUrl && (
                      <Field label={t("settings.fields.baseUrl")}>
                        <Input
                          value={settings.asr.base_url}
                          placeholder="https://api.openai.com/v1"
                          onChange={(event) =>
                            patch("asr", "base_url", event.target.value)
                          }
                        />
                      </Field>
                    )}

                    <Field label={t("settings.fields.apiKey")}>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={settings.asr.api_key}
                        placeholder="sk-…"
                        onChange={(event) =>
                          patch("asr", "api_key", event.target.value)
                        }
                      />
                    </Field>
                  </section>

                  <Separator />

                  <section className="grid gap-3" data-slot="settings-section">
                    <h3 className="text-sm font-semibold">
                      {t("settings.sections.llm")}
                    </h3>
                    <Field label={t("settings.fields.provider")}>
                      <ProviderSelect
                        providers={LLM_PROVIDERS}
                        value={settings.llm.provider}
                        onChange={changeLlmProvider}
                      />
                    </Field>

                    <div className={FORM_GRID}>
                      <Field
                        label={t("settings.fields.model")}
                        className={showLlmBaseUrl ? "" : "sm:col-span-2"}
                      >
                        <Input
                          value={settings.llm.model}
                          placeholder="gpt-4o-mini"
                          onChange={(event) =>
                            patch("llm", "model", event.target.value)
                          }
                        />
                      </Field>
                      {showLlmBaseUrl && (
                        <Field label={t("settings.fields.baseUrl")}>
                          <Input
                            value={settings.llm.base_url}
                            placeholder="https://api.openai.com/v1"
                            onChange={(event) =>
                              patch("llm", "base_url", event.target.value)
                            }
                          />
                        </Field>
                      )}
                    </div>

                    <Field label={t("settings.fields.apiKey")}>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={settings.llm.api_key}
                        placeholder="sk-…"
                        onChange={(event) =>
                          patch("llm", "api_key", event.target.value)
                        }
                      />
                    </Field>

                    <Field label={t("settings.fields.disableThinking")}>
                      <div className="flex h-8 items-center">
                        <Switch
                          checked={settings.llm.disable_thinking !== false}
                          onCheckedChange={(next) =>
                            setSettings((current) =>
                              current
                                ? {
                                    ...current,
                                    llm: {
                                      ...current.llm,
                                      disable_thinking: Boolean(next),
                                    },
                                  }
                                : current,
                            )
                          }
                        />
                      </div>
                    </Field>

                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {t("settings.builtinPrompts")}
                    </p>
                  </section>

                  <Separator />

                  <section className="grid gap-3" data-slot="settings-section">
                    <h3 className="text-sm font-semibold">
                      {t("settings.sections.embedding")}
                    </h3>
                    <Field label={t("settings.fields.embeddingModel")}>
                      <Input
                        value={settings.embedding.model}
                        placeholder="BAAI/bge-small-zh-v1.5"
                        spellCheck={false}
                        disabled
                      />
                    </Field>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("settings.embedding.hint")}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {t("settings.embedding.indexed", {
                          ready: qaStatus?.ready ?? 0,
                          total: qaStatus?.total ?? 0,
                        })}
                      </span>
                      {qaStatus && qaStatus.failed > 0 && (
                        <span className="text-destructive">
                          {t("qa.failedRetry", { count: qaStatus.failed })}
                        </span>
                      )}
                      {qaStatus && qaStatus.pending + qaStatus.indexing > 0 && (
                        <span>
                          {t("qa.indexing", {
                            count: qaStatus.pending + qaStatus.indexing,
                          })}
                        </span>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={rebuilding}
                        onClick={() => void rebuildIndex()}
                      >
                        {rebuilding && <Spinner className="size-3" />}
                        {t("settings.embedding.rebuild")}
                      </Button>
                    </div>
                    {qaStatus?.lastError && (
                      <p className="text-destructive text-xs">{qaStatus.lastError}</p>
                    )}
                  </section>
                </div>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>

        <div className="flex h-14 shrink-0 items-center justify-between border-t border-border px-4">
          <span
            className={`min-w-0 truncate text-xs ${
              status === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {status === "saving" || status === "saved" || status === "error"
              ? message || (status === "saving" ? t("settings.saving") : "")
              : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {tab === "models" ? t("settings.cancel") : t("settings.close")}
            </Button>
            {tab === "models" && (
              <Button
                size="sm"
                disabled={!settings || status === "saving"}
                onClick={() => void onSave()}
              >
                {status === "saving" ? t("settings.saving") : t("settings.save")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
