/**
 * Offscreen document whose only job is to empty the clipboard after a copied
 * secret's timeout. A service worker has no clipboard, and the popup is
 * usually closed by then. It never reads the clipboard.
 */
chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== "offscreen") return;
  if (msg.type !== "clear-clipboard") return;
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", "");
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy, { once: true });
  document.execCommand("copy");
  document.removeEventListener("copy", onCopy);
});
