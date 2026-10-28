"use client";

import { ArrowRightIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

export function LoginPanel() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"token" | "oidc" | "google_desktop" | null>(null);

  useEffect(() => {
    const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
    if (match) {
      setToken(match[1]);
      window.history.replaceState(null, "", "/login");
    }
    fetch("/api/auth/mode", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ mode?: string }> : null)
      .then((result) => setMode(result?.mode === "token" || result?.mode === "oidc" || result?.mode === "google_desktop" ? result.mode : null))
      .catch(() => setMode(null));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/auth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error();
      router.replace("/");
      router.refresh();
    } catch {
      setError("That access token was not accepted. Check the token and try again.");
    } finally {
      setPending(false);
    }
  }

  if (mode && mode !== "token") return <main className="login-shell"><section className="login-card" aria-labelledby="login-title"><div className="brand-mark" aria-hidden="true" /><h1 id="login-title">Sign in to Jobber</h1><p>Continue with the account configured for this operator dashboard.</p><a className="button primary" href="/auth/login">Continue to sign in <ArrowRightIcon size={15} weight="bold" aria-hidden="true" /></a></section></main>;
  return <main className="login-shell"><section className="login-card" aria-labelledby="login-title"><div className="brand-mark" aria-hidden="true" /><h1 id="login-title">Sign in to Jobber</h1><p>Use the access token generated for this Next.js dashboard. The token is not retained in this interface.</p><form className="login-form" onSubmit={submit}><label htmlFor="access-token">Access token</label><input id="access-token" name="token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} required />{error ? <p className="form-error" role="alert">{error}</p> : null}<button className="button primary" type="submit" disabled={pending}>{pending ? "Signing in" : "Continue"} <ArrowRightIcon size={15} weight="bold" aria-hidden="true" /></button></form></section></main>;
}
