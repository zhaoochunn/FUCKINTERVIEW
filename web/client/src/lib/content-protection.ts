"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 桌面端的防截屏 / 防录屏开关。
 *
 * 真正的窗口保护在主进程里（Windows 的 WDA_EXCLUDEFROMCAPTURE），
 * 渲染进程只负责读取持久化状态并下发切换。浏览器版没有这个能力，
 * supported 为 false，设置页据此隐藏这一项。
 */
export function useContentProtection() {
  const api =
    typeof window === "undefined" ? undefined : window.desktop?.privacy;
  const supported = api?.supported === true;
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    if (!api || !supported) return;
    let cancelled = false;
    api
      .getContentProtection()
      .then((value) => {
        if (!cancelled) setEnabledState(Boolean(value));
      })
      .catch(() => {
        // 读不到就保持关闭；主进程启动时会按持久化值先应用一次。
      });
    return () => {
      cancelled = true;
    };
  }, [api, supported]);

  const setEnabled = useCallback(
    (value: boolean) => {
      setEnabledState(value);
      if (!api || !supported) return;
      void api
        .setContentProtection(value)
        .then((actual) => setEnabledState(Boolean(actual)))
        .catch(() => {
          // 主进程拒绝/失败时回读真实状态，避免开关显示和窗口不一致。
          void api
            .getContentProtection()
            .then((actual) => setEnabledState(Boolean(actual)))
            .catch(() => {});
        });
    },
    [api, supported]
  );

  return { supported, enabled, setEnabled };
}
