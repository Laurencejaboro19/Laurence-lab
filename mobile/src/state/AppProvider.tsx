/**
 * App-wide state: which API we talk to (live or demo), the customer session,
 * the menu, and the server-side cart quote. One provider, three hooks.
 */
import * as Crypto from 'expo-crypto';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, liveApi, setTokenProvider } from '@/api/client';
import type { AppConfig, CartQuote, Customer, LaurenceApi, MenuCategory } from '@/api/types';
import { demoApi } from '@/demo/demoApi';

import { getItem, removeItem, setItem } from './storage';

const KEY_INSTALL = 'll.installId';
const KEY_TOKEN = 'll.token';
const KEY_PROFILE = 'll.profile';
const KEY_FORCE_DEMO = 'll.forceDemo';

interface Profile {
  displayName: string;
  phone: string;
}

interface AppState {
  ready: boolean;
  api: LaurenceApi;
  mode: 'live' | 'demo';
  config: AppConfig | null;
  customer: Customer | null;
  profile: Profile | null;
  menu: MenuCategory[];
  menuError: string | null;
  cart: CartQuote | null;
  cartCount: number;
  cartBusy: boolean;
  signIn(profile: Profile): Promise<void>;
  signOut(): Promise<void>;
  refreshMenu(): Promise<void>;
  refreshCart(): Promise<void>;
  mutateCart(fn: (api: LaurenceApi) => Promise<CartQuote>): Promise<CartQuote>;
  setForceDemo(on: boolean): Promise<void>;
  refreshCustomer(): Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isNetwork) return 'No connection. Check your network and try again.';
    return err.message;
  }
  if (err && typeof err === 'object' && 'message' in err) return String((err as Error).message);
  return 'Something went wrong. Please try again.';
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [api, setApi] = useState<LaurenceApi>(liveApi);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [menu, setMenu] = useState<MenuCategory[]>([]);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartQuote | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  const token = useRef<string | null>(null);
  const installId = useRef<string>('');

  useEffect(() => {
    setTokenProvider(() => token.current);
  }, []);

  /** Pick live or demo once, at startup: live if the server answers /config. */
  const chooseApi = useCallback(async (): Promise<LaurenceApi> => {
    if ((await getItem(KEY_FORCE_DEMO)) === '1') return demoApi;
    try {
      const cfg = await liveApi.config();
      setConfig(cfg);
      return liveApi;
    } catch {
      return demoApi;
    }
  }, []);

  const loadMenu = useCallback(async (a: LaurenceApi) => {
    try {
      setMenu(await a.menu());
      setMenuError(null);
    } catch (err) {
      setMenuError(errorMessage(err));
    }
  }, []);

  const establishSession = useCallback(
    async (a: LaurenceApi, p: Profile): Promise<Customer> => {
      const s = await a.session({
        installId: installId.current,
        displayName: p.displayName,
        ...(p.phone ? { phone: p.phone } : {}),
      });
      token.current = s.token;
      await setItem(KEY_TOKEN, s.token);
      setCustomer(s.customer);
      return s.customer;
    },
    [],
  );

  /** The live server is up but cannot serve app sessions yet (e.g. migration pending): demo instead. */
  const fallbackToDemo = useCallback(
    async (p: Profile): Promise<LaurenceApi> => {
      setApi(demoApi);
      setConfig(await demoApi.config());
      setMenu(await demoApi.menu());
      await establishSession(demoApi, p);
      return demoApi;
    },
    [establishSession],
  );

  const serverCannotServeApp = (err: unknown): boolean =>
    err instanceof ApiError && (err.status >= 500 || err.status === 404);

  // Boot
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id = await getItem(KEY_INSTALL);
      if (!id) {
        id = Crypto.randomUUID();
        await setItem(KEY_INSTALL, id);
      }
      installId.current = id;
      let a = await chooseApi();
      if (cancelled) return;
      setApi(a);
      if (a.mode === 'demo') setConfig(await a.config());
      const rawProfile = await getItem(KEY_PROFILE);
      const p = rawProfile ? (JSON.parse(rawProfile) as Profile) : null;
      setProfile(p);
      const savedToken = await getItem(KEY_TOKEN);
      await loadMenu(a);
      if (p) {
        try {
          try {
            if (a.mode === 'live' && savedToken) {
              token.current = savedToken;
              try {
                setCustomer(await a.me());
              } catch (err) {
                if (err instanceof ApiError && (err.status === 401 || err.status === 403))
                  await establishSession(a, p);
                else throw err;
              }
            } else {
              await establishSession(a, p);
            }
          } catch (err) {
            if (a.mode === 'live' && serverCannotServeApp(err)) a = await fallbackToDemo(p);
            else throw err;
          }
          setCart(await a.cart());
        } catch {
          /* shown on the relevant screen; the app still opens */
        }
      }
      if (!cancelled) setReady(true);
    })().catch(() => setReady(true));
    return () => {
      cancelled = true;
    };
  }, [chooseApi, establishSession, loadMenu, fallbackToDemo]);

  const signIn = useCallback(
    async (p: Profile) => {
      let a = api;
      try {
        await establishSession(a, p);
      } catch (err) {
        if (a.mode === 'live' && serverCannotServeApp(err)) a = await fallbackToDemo(p);
        else throw err;
      }
      await setItem(KEY_PROFILE, JSON.stringify(p));
      setProfile(p);
      setCart(await a.cart());
    },
    [api, establishSession, fallbackToDemo],
  );

  const signOut = useCallback(async () => {
    token.current = null;
    await removeItem(KEY_TOKEN);
    await removeItem(KEY_PROFILE);
    setProfile(null);
    setCustomer(null);
    setCart(null);
  }, []);

  const refreshMenu = useCallback(() => loadMenu(api), [api, loadMenu]);
  const refreshCart = useCallback(async () => {
    if (!profile) return;
    setCart(await api.cart());
  }, [api, profile]);
  const refreshCustomer = useCallback(async () => {
    if (!profile) return;
    setCustomer(await api.me());
  }, [api, profile]);

  const mutateCart = useCallback(
    async (fn: (a: LaurenceApi) => Promise<CartQuote>) => {
      setCartBusy(true);
      try {
        const q = await fn(api);
        setCart(q);
        return q;
      } finally {
        setCartBusy(false);
      }
    },
    [api],
  );

  const setForceDemo = useCallback(async (on: boolean) => {
    if (on) await setItem(KEY_FORCE_DEMO, '1');
    else await removeItem(KEY_FORCE_DEMO);
  }, []);

  const cartCount = useMemo(
    () => cart?.cart.lines.reduce((n, l) => n + l.quantity, 0) ?? 0,
    [cart],
  );

  const value = useMemo<AppState>(
    () => ({
      ready,
      api,
      mode: api.mode,
      config,
      customer,
      profile,
      menu,
      menuError,
      cart,
      cartCount,
      cartBusy,
      signIn,
      signOut,
      refreshMenu,
      refreshCart,
      mutateCart,
      setForceDemo,
      refreshCustomer,
    }),
    [ready, api, config, customer, profile, menu, menuError, cart, cartCount, cartBusy, signIn, signOut, refreshMenu, refreshCart, mutateCart, setForceDemo, refreshCustomer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
