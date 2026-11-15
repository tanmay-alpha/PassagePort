import { type FormEvent, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'

import { errorMessage } from '@/api/client'
import { useAuthenticate, useGuestSession, useSession } from '@/api/queries'
import type { SessionOut } from '@/api/types'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/Button'
import { Card, EmptyState, Notice, Spinner } from '@/components/ui/Feedback'
import { Field, Input } from '@/components/ui/Form'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { useDocumentTitle } from '@/lib/hooks'

// Mirrors CredentialsIn in the API contract.
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/
const PASSWORD_MIN = 10
const PASSWORD_MAX = 200

/** Only same-origin paths are accepted as a post-login destination. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/login') ? next : '/'
}

export function Component() {
  useDocumentTitle('Sign in')
  const session = useSession()
  const [params] = useSearchParams()

  if (session.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-2">
        <Spinner label="Loading…" />
      </div>
    )
  }
  if (session.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <EmptyState
          title="PassagePort can’t reach its server"
          description={errorMessage(session.error)}
          action={
            <Button variant="primary" loading={session.isFetching} onClick={() => void session.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }
  // Local mode has no accounts; signed-in users have nothing to do here.
  if (session.data.auth_mode === 'local' || session.data.authenticated) {
    return <Navigate to={safeNext(params.get('next'))} replace />
  }
  return <SignIn session={session.data} />
}

function SignIn({ session }: { session: SessionOut }) {
  const guest = useGuestSession()
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo size={28} className="mb-6" />
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">Sign in to PassagePort</h1>
        <p className="mt-1 text-sm text-ink-2">Your workspaces and documents are private to your account.</p>

        <Card className="mt-6 p-5">
          {session.signup_enabled ? (
            <Tabs defaultValue="login">
              <TabsList aria-label="Account" className="mb-4">
                <TabsTrigger value="login">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Create account</TabsTrigger>
              </TabsList>
              <TabsContent value="login">
                <CredentialsForm action="login" requiresCode={false} />
              </TabsContent>
              <TabsContent value="signup">
                <CredentialsForm action="signup" requiresCode={session.signup_requires_code} />
              </TabsContent>
            </Tabs>
          ) : (
            <CredentialsForm action="login" requiresCode={false} />
          )}
        </Card>

        {session.guests_enabled ? (
          <div className="mt-4">
            <Button className="w-full" loading={guest.isPending} onClick={() => guest.mutate()}>
              Continue as guest
            </Button>
            <p className="mt-2 text-[13px] text-ink-3">
              A guest session is temporary. Its documents are removed when the session expires.
            </p>
            {guest.isError ? (
              <Notice tone="danger" className="mt-3">
                {errorMessage(guest.error)}
              </Notice>
            ) : null}
          </div>
        ) : null}
        {!session.signup_enabled ? (
          <p className="mt-4 text-[13px] text-ink-3">New accounts are disabled on this server. Ask its administrator for access.</p>
        ) : null}
      </div>
    </main>
  )
}

interface FormErrors {
  username?: string
  password?: string
  code?: string
}

function validate(action: 'login' | 'signup', username: string, password: string, code: string, requiresCode: boolean): FormErrors {
  const errors: FormErrors = {}
  if (!USERNAME_PATTERN.test(username)) {
    errors.username = 'Use 3–32 letters, digits, dots, hyphens or underscores.'
  }
  if (password.length < PASSWORD_MIN) {
    errors.password =
      action === 'signup'
        ? `Use at least ${PASSWORD_MIN} characters.`
        : `Passwords have at least ${PASSWORD_MIN} characters.`
  } else if (password.length > PASSWORD_MAX) {
    errors.password = `Use at most ${PASSWORD_MAX} characters.`
  }
  if (requiresCode && code.trim().length === 0) errors.code = 'Enter the signup code you were given.'
  return errors
}

function CredentialsForm({ action, requiresCode }: { action: 'login' | 'signup'; requiresCode: boolean }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const authenticate = useAuthenticate(action)
  const signup = action === 'signup'

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const name = username.trim()
    const found = validate(action, name, password, code, requiresCode)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    // On success the session query updates and the page redirects.
    authenticate.mutate({ username: name, password, ...(requiresCode ? { signup_code: code.trim() } : {}) })
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field label="Username" error={errors.username}>
        {(control) => (
          <Input
            {...control}
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
            required
          />
        )}
      </Field>
      <Field label="Password" error={errors.password} hint={signup ? `At least ${PASSWORD_MIN} characters.` : undefined}>
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={signup ? 'new-password' : 'current-password'}
            maxLength={PASSWORD_MAX}
            required
          />
        )}
      </Field>
      {requiresCode ? (
        <Field label="Signup code" error={errors.code} hint="This server only accepts new accounts with a code from its administrator.">
          {(control) => (
            <Input
              {...control}
              name="signup_code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              maxLength={200}
              required
            />
          )}
        </Field>
      ) : null}
      {authenticate.isError ? (
        <Notice tone="danger" title={signup ? 'The account could not be created.' : 'Sign-in failed.'}>
          {errorMessage(authenticate.error)}
        </Notice>
      ) : null}
      <Button type="submit" variant="primary" loading={authenticate.isPending}>
        {signup ? 'Create account' : 'Sign in'}
      </Button>
    </form>
  )
}
