import { createContext, useContext } from "react";

/** Owning native window, supplied by each independent desktop React root. */
export const WindowContext = createContext<string | null>(null);
export const useWindowId = (): string | null => useContext(WindowContext);
