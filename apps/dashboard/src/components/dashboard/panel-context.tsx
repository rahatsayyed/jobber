"use client";

import { usePathname } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { buildPanelUrl, crumbLabel, PanelRef, parsePanelParams, popPanel, pushPanel } from "@/lib/view-models";

export type PanelNav = { crumbs: string[]; onBack?: () => void; onClose: () => void };
type Ctx = { open: (ref: PanelRef) => void };

const PanelContext = createContext<Ctx>({ open: () => undefined });
/** `open(ref)` shows that record in the side panel and puts it on the back stack. */
export const usePanels = () => useContext(PanelContext);

/**
 * One linked side panel for every page. The stack lives in state; the top entry is mirrored into the URL (?job=, ?mail=, ?person=)
 * with replaceState so a refresh or a shared link reopens it. Leaving the page closes the panel. Esc closes all of it.
 */
export function PanelProvider({ render, children }: { render: (ref: PanelRef, nav: PanelNav) => ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const [stack, setStack] = useState<PanelRef[]>([]);
  const ready = useRef(false);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const ref = parsePanelParams(new URLSearchParams(window.location.search));
      if (ref) setStack([ref]);
      ready.current = true;
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (lastPath.current !== null && lastPath.current !== pathname) {
      const t = window.setTimeout(() => setStack([]), 0);
      lastPath.current = pathname;
      return () => window.clearTimeout(t);
    }
    lastPath.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!ready.current) return;
    const top = stack[stack.length - 1] ?? null;
    const url = buildPanelUrl(window.location.pathname, new URLSearchParams(window.location.search), top);
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", url);
  }, [stack]);

  const open = useCallback((ref: PanelRef) => setStack((s) => pushPanel(s, ref)), []);
  const back = useCallback(() => setStack((s) => popPanel(s)), []);
  const closeAll = useCallback(() => setStack([]), []);
  const value = useMemo(() => ({ open }), [open]);
  const top = stack[stack.length - 1];
  return <PanelContext.Provider value={value}>
    {children}
    {top ? <div key={`${top.kind}:${top.id}`}>{render(top, { crumbs: stack.map(crumbLabel), onBack: stack.length > 1 ? back : undefined, onClose: closeAll })}</div> : null}
  </PanelContext.Provider>;
}
