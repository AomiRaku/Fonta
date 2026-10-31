// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

// 在首屏样式生效前恢复上次主题，避免深色模式启动时闪白。
(() => {
  try {
    const mode = localStorage.getItem("fontfox.themeMode");
    const dark =
      mode === "dark" ||
      (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
  }
})();
