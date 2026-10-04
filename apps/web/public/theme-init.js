// Applies the saved theme before first paint, so there is no flash.
(() => {
  let theme = "system";
  try {
    theme = localStorage.getItem("minions-theme") || "system";
  } catch {
    /* storage blocked: follow the system */
  }
  const dark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
})();
