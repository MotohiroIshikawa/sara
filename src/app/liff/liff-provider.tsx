'use client';

import liff, { type Liff } from '@line/liff';
import {
  createContext,
  useState,
  useEffect,
  FC,
  ReactNode,
  useContext,
} from 'react';

type LiffContextType = {
  liffState: Liff | null;
  liffError: string | null;
};

const LiffContext = createContext<LiffContextType>({
  liffState: null,
  liffError: null,
});

export const useLiff = (): LiffContextType => {
  const context = useContext(LiffContext);
  return context;
};

export const LiffProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [liffState, setliffState] = useState<Liff | null>(null);
  const [liffError, setLiffError] = useState<string | null>(null);

  useEffect(() => {
    // liff.init()
    liff.init(
      { liffId: process.env.NEXT_PUBLIC_LIFF_ID_FULL || '' },
      () => { setliffState(liff); },
      (error) => {
        console.error('LIFF initialization failed', error);
        setLiffError(error.toString());
      },
    );
  }, []);

  return (
    <LiffContext.Provider value={{ liffState, liffError }}>
      {children}
    </LiffContext.Provider>
  );
};