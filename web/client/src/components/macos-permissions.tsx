import { NativeAudioCheck } from "./native-audio-check";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

type Status = { microphone: string; camera: string; screen: string };

export function MacOSPermissions() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const api = window.desktop?.permissions;
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!api) return;
    try { setStatus(await api.status()); setError(false); }
    catch { setError(true); }
  }, [api]);
  useEffect(() => {
    if (window.desktop?.platform !== "darwin") return;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  if (window.desktop?.platform !== "darwin") return null;
  const labels: Record<string, string> = zh ? {
    granted: "已允许", denied: "已拒绝", restricted: "受限制",
    "not-determined": "尚未询问", unknown: "未知", unavailable: "不可用",
  } : {};
  const state = (value?: string) => value ? labels[value] || value : (zh ? "读取中" : "Loading");
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p>{zh ? "macOS 权限状态" : "macOS permissions"}</p>
      <p>{zh ? "麦克风" : "Microphone"}: {state(status?.microphone)} · {zh ? "摄像头" : "Camera"}: {state(status?.camera)} · {zh ? "屏幕录制" : "Screen recording"}: {state(status?.screen)}</p>
      <p>{zh
        ? "系统音频桥接正在实机验证，不提供可靠防截屏能力。被拒绝的权限请在系统设置 → 隐私与安全性中修改，必要时重启应用。"
        : "System audio bridging needs device validation; reliable capture protection is unavailable. Change denied permissions in System Settings → Privacy & Security, then restart if needed."}</p>
      <NativeAudioCheck zh={zh} />
      {error && <p role="alert">{zh ? "无法读取或申请权限，请检查系统设置。" : "Cannot read or request permissions. Check System Settings."}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>{zh ? "刷新状态" : "Refresh"}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || !api || status?.microphone === "granted"} onClick={async () => {
          if (!api) return;
          setBusy(true);
          try { await api.requestMicrophone(); await refresh(); }
          catch { setError(true); }
          finally { setBusy(false); }
        }}>{zh ? "申请麦克风权限" : "Request microphone access"}</Button>
      </div>
    </div>
  );
}
