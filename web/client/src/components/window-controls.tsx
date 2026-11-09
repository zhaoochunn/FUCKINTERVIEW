"use client";

import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const BUTTON_CLASS = cn(
  "inline-flex size-8 items-center justify-center rounded-md",
  "text-muted-foreground transition-colors",
  "hover:bg-accent hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
);

/**
 * 桌面端的最小化 / 最大化 / 关闭。
 *
 * 和页头放在同一行、同一个 flex 流里，所以它就是页头的一部分：
 * 页头是拖拽区（`app-drag`），这三个按钮所在的容器标 `app-no-drag` 才收得到鼠标事件。
 * 浏览器里 `window.desktop` 不存在，整组不渲染。
 */
export function WindowControls({ className }: { className?: string }) {
  const desktop = typeof window === "undefined" ? undefined : window.desktop;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void desktop.isMaximized().then((value) => {
      if (alive) setMaximized(value);
    });
    const unsubscribe = desktop.onMaximizeChange(setMaximized);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [desktop]);

  // macOS uses the native traffic-light controls and title bar.
  if (!desktop || desktop.platform === "darwin") return null;

  const maximizeLabel = maximized ? "还原" : "最大化";

  return (
    <div
      role="group"
      aria-label="窗口控制"
      className={cn("app-no-drag flex shrink-0 items-center gap-1", className)}
    >
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        className={BUTTON_CLASS}
        onClick={() => desktop.minimize()}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximizeLabel}
        title={maximizeLabel}
        className={BUTTON_CLASS}
        onClick={() => desktop.toggleMaximize()}
      >
        {maximized ? (
          <CopyIcon className="size-3.5" />
        ) : (
          <SquareIcon className="size-3" />
        )}
      </button>
      <button
        type="button"
        aria-label="关闭到托盘"
        title="关闭到托盘"
        className={cn(BUTTON_CLASS, "hover:bg-destructive hover:text-white")}
        onClick={() => desktop.close()}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
