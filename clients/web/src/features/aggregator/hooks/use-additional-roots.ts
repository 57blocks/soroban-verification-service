import { useCallback, useState } from "react";

export type AdditionalRoot = { id: string; url: string };

/** Result roots the reader adds for this session only. */
export const useAdditionalRoots = () => {
  const [roots, setRoots] = useState<AdditionalRoot[]>([]);

  const add = useCallback((raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return "Give a result root URL.";

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return "That is not a URL.";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "A result root must be an http(s) URL.";
    }

    // Normalised the way the SDK resolves a root — query and fragment dropped, host lower-cased, trailing slash
    // trimmed.
    parsed.search = "";
    parsed.hash = "";
    const url = parsed.toString().replace(/\/+$/, "");

    // Checked against the rendered list, not read back out of the updater — React may call an updater twice, so
    // a flag set inside one is not a value you can return.
    if (roots.some((root) => root.url === url)) return "That root is already in the list.";
    setRoots((current) =>
      current.some((root) => root.url === url) ? current : [...current, { id: url, url }],
    );
    return null;
  }, [roots]);

  const remove = useCallback((id: string) => {
    setRoots((current) => current.filter((root) => root.id !== id));
  }, []);

  return { roots, add, remove };
};
