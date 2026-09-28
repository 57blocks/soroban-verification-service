import { toast } from "sonner";

const copyBySelection = (text: string) => {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen but focusable: `display: none` makes `select()` a no-op; `fixed` avoids scrolling on focus.
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

export const copyValue = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
      return;
    } catch {
      // Permission denied or unavailable here: fall back to the legacy path.
    }
  }

  if (copyBySelection(text)) {
    toast.success("Copied");
  } else {
    toast.error("Copy failed");
  }
};
