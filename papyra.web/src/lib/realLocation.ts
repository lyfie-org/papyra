import { createContext, useContext } from 'react';
import type { Location } from 'react-router-dom';

/**
 * The browser's actual location. While a note is open App routes the main
 * outlet by the page behind it (`<Routes location={background}>`), and React
 * Router hands that background location to everything inside those routes via
 * useLocation(). The shell needs the real one to know which note to draw.
 */
export const RealLocationContext = createContext<Location | null>(null);

export function useRealLocation(): Location | null {
  return useContext(RealLocationContext);
}
