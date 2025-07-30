'use client';

import { useState, useCallback, useEffect } from "react";
import { useLiff } from "./liff-provider";

export default function Page() {
  const { liffState, liffError } = useLiff();
  const [authenticated, setAuthenticated] = useState(false);

  const login = useCallback(async () => {
    const token = liffState?.getAccessToken();
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      console.error('failed to login');
      return;
    }
    setAuthenticated(true);
    window.location.href = '/liff-top>';
  }, [liffState, setAuthenticated]);

  useEffect(() => {
    if (!liffState || authenticated) return;
    login();
  }, [liffState, authenticated, login]);

  if (liffError) {
    return 'liffError';
  }

  if (!authenticated) {
    return 'authenticating...';
  }

  return 'authenticated';
}