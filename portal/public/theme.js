// 스타일시트보다 먼저 저장된 테마를 적용하여 화면 전환 시 밝은 배경이 깜빡이지 않게 한다.
(() => {
  "use strict";
  const storageKey = "paas-theme";
  const root = document.documentElement;

  function applyTheme(theme) {
    const dark = theme === "dark";
    root.dataset.theme = dark ? "dark" : "light";
    const button = document.getElementById("theme-toggle-btn");
    if (button) {
      button.setAttribute("aria-pressed", String(dark));
      button.title = dark ? "Switch to light theme" : "Switch to dark theme";
    }
  }

  let savedTheme = "light";
  try { savedTheme = localStorage.getItem(storageKey); } catch { /* 저장소가 제한되어도 전환은 허용한다. */ }
  applyTheme(savedTheme);

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(root.dataset.theme);
    document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
      const theme = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(theme);
      try { localStorage.setItem(storageKey, theme); } catch { /* 현재 화면에는 계속 적용한다. */ }
    });
  }, { once: true });

  // 같은 브라우저의 다른 탭에서도 선택한 테마를 반영한다.
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
