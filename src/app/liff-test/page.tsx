"use client";

import { useEffect, useState } from "react";
import liff from "@line/liff";

export default function LiffPage() {
  const [profile, setProfile] = useState<any>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // LIFFの初期化
    const initializeLiff = async () => {
      try {
        await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID || "" });

        // ログイン状態の確認
        if (liff.isLoggedIn()) {
          setIsLoggedIn(true);
          fetchUserProfile();
        }
      } catch (error) {
        console.error("LIFF initialization failed", error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeLiff();
  }, []);

  // ユーザープロフィールの取得
  const fetchUserProfile = async () => {
    try {
      const profile = await liff.getProfile();
      setProfile(profile);
    } catch (error) {
      console.error("Failed to fetch user profile", error);
    }
  };

  // ログイン処理
  const handleLogin = () => {
    liff.login();
  };

  // ログアウト処理
  const handleLogout = () => {
    liff.logout();
    setIsLoggedIn(false);
    setProfile(null);
  };

  // メッセージ送信
  const handleSendMessage = () => {
    liff
      .sendMessages([
        {
          type: "text",
          text: "LIFFアプリからのメッセージです！",
        },
      ])
      .then(() => {
        console.log("Message sent");
      })
      .catch((error: any) => {
        console.error("Error sending message", error);
      });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        読み込み中...
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">LINE LIFF アプリ</h1>

      {isLoggedIn ? (
        <div className="space-y-4">
          {profile && (
            <div className="border p-4 rounded-lg">
                <p className="text-center font-bold">{profile.displayName}</p>
            </div>
          )}

          <div className="flex flex-col space-y-2">
            <button
              onClick={handleSendMessage}
              className="bg-green-500 hover:bg-green-600"
            >
              メッセージを送信
            </button>
            <button onClick={handleLogout} variant="outline">
              ログアウト
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={handleLogin}
          className="bg-green-500 hover:bg-green-600 w-full"
        >
          LINEでログイン
        </button>
      )}
    </div>
  );
}