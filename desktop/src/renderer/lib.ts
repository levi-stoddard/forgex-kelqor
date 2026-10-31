import { useCallback, useEffect, useRef, useState } from "react";
import type { KelqorBridge, Result } from "../shared/bridge";

declare global {
  interface Window {
    kelqor: KelqorBridge;
  }
}

/** The main process's bridge, the window's only way to reach data or the operating system. */
export const kelqor = (): KelqorBridge => window.kelqor;

/** Loads one bridge result, reloading when `deps` change (the connection epoch among them). */
export function useResult<T>(load: () => Promise<Result<T>>, deps: unknown[]) {
  const [state, setState] = useState<{ loading: boolean; result: Result<T> | null }>({ loading: true, result: null });
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const call = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    const result = await load();
    if (call === latest.current) setState({ loading: false, result });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload, data: state.result?.ok ? state.result.data : null };
}

export const usd = (value: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
