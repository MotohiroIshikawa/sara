import { getServerSession } from 'next-auth';
import { LogoutButton } from './components/buttons'
import { authOptions } from './options';
import { redirect } from 'next/navigation';

export default async function Home() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect('/sign_in')
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center">
      <div>Welcome: {session?.user?.name}</div>
      <LogoutButton/>
    </main>
  )
}