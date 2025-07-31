'use client';

import { useLiff } from './liff-provider';
import { Profile } from '@liff/get-profile';
import { useEffect, useState } from 'react';

export default function Page() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const { liffState } = useLiff();

  useEffect(() => {
    if (liffState?.isLoggedIn()) {
      (async () => {
        const profile = await liffState.getProfile();
        setProfile(profile);
      })();
    }
  }, [liffState]);

  return (
    <div>
      {profile && (
        <>
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

