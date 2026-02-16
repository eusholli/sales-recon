import { SignedIn, SignedOut, RedirectToSignIn } from "@clerk/nextjs";
import ChatInterface from "./components/ChatInterface";

export default function Home() {
  return (
    <main className="min-h-screen bg-black">
      <SignedIn>
        <ChatInterface />
      </SignedIn>
      <SignedOut>
        <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-bold">Authentication Required</h1>
            <p className="text-gray-400">Please sign in to access the system.</p>
            <div className="bg-white rounded p-1">
                 <RedirectToSignIn />
            </div>
          </div>
        </div>
      </SignedOut>
    </main>
  );
}
