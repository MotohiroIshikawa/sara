'use client';

import { useLiff } from './liff-provider';
import { Profile as LineProfile } from '@liff/get-profile';
import { useEffect, useState } from 'react';

export default function Page() {
  const [lineProfile, setProfile] = useState<LineProfile | null>(null);
  const { liffState } = useLiff();

  useEffect(() => {
    if (liffState?.isLoggedIn()) {
      (async () => {
        const lineProfile = await liffState.getProfile();
        setProfile(lineProfile);
      })();
    }
  }, [liffState]);

  return (
    <div>
      {lineProfile && (
        <>
          <p>LIFF: ログインなしでユーザプロファイルが取得可能</p>
          <p></p>
          <p className="font-bold">UserProfile</p>
          <p>userId: {lineProfile.userId}</p>
          <p>displayName: {lineProfile.displayName}</p>
          <p>statusMessage: {lineProfile.statusMessage || ""}</p>
          <p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lineProfile.pictureUrl}
              alt='profile'
              className='rounded-full w-20 h-20 mx-auto mb-4'
            />
          </p>
        </>
      )}
    </div>
  );
}

