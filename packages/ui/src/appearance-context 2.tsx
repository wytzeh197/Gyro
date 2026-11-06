import { createContext, useContext } from "react";

/** Canvas renderers use the same scale as CSS without zooming native host bounds. */
export const AppearanceContext = createContext({
  scale: 1,
  reduceMotion: false,
});
export const useAppearance = () => useContext(AppearanceContext);
