'use client';

import { signIn, signOut } from "next-auth/react";

export const LoginButton = () => {
  return (
    <button
      className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
      onClick={() => signIn('line', { callbackUrl: '/' })}
    >
      ログイン
    </button>
  );
};

export const LogoutButton = () => {
  return (
    <button
      className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
      onClick={() => signOut()}
    >
      ログアウト
    </button>
  );
};