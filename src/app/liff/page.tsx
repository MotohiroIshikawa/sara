'use client';

import { useLiff } from './LiffProvider';
import type { Profile } from '@liff/get-profile';
import { useEffect, useState } from 'react';

export function Profile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const { liff } = useLiff();

  useEffect(() => {
    if (liff?.isLoggedIn()) {
      (async () => {
        const profile = await liff.getProfile();
        setProfile(profile);
      })();
    }
  }, [liff]);

  return (
    <div>
      {profile && (
        <>
          <p className='text-center font-bold text-xl'>LIFF: LINEログインなしでユーザプロファイルを取得できる</p>
          {/* eslint-disable-next-line @next/next/no-img-element */},
          <img
            src={profile.pictureUrl}
            alt='profile'
            className='rounded-full w-20 h-20 mx-auto mb-4'
          />
          <p className='text-center font-bold text-xl'>userId: {profile.userId}</p>
          <p className='text-center text-gray-500'>displayName: {profile.displayName}</p>
        </>
      )}
    </div>
  );
}