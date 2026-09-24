import { toast } from "sonner";

/** The pre-Clipboard-API copy: select a detached textarea and let the browser copy the selection. */
const copyBySelection = (text: string) => {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen but still focusable — `display: none` would make `select()` a no-op, and a `position: fixed`
  // element at the top-left avoids scrolling the page on focus.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.select();
  let copied: boolean;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  document.body.removeChild(textarea);
  if (selection && previousRange) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  return copied;
};

/**
 * `navigator.clipboard.writeText` is the right API but it is not always available: it is undefined on a
 * plain-http origin, and it rejects with `NotAllowedError` when the page has no clipboard-write permission
 * (embedded browsers, cross-origin frames, Safari outside a direct gesture).
 */
export const copyValue = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
      return;
    } catch {
      // Permission denied or the API is unavailable in this context — try the legacy path.
    }
  }

  if (copyBySelection(text)) {
    toast.success("Copied");
  } else {
    toast.error("Copy failed");
  }
};
