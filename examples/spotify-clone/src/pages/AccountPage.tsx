import type { FormEvent } from 'react'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { reads, writes } from '../api/client'
import { QueryState } from '../components/QueryState'

/**
 * The caller's account, a singleton the server serves at `/me` with no id. `reads.accounts.get()`
 * reads it without an id, and the rename runs `writes.accounts.update()`, whose input carries the
 * id the read returned, since the request body needs it although the path has none.
 */
export function AccountPage() {
  const accountQuery = useQuery(reads.accounts.get())
  const account = accountQuery.data
  const [name, setName] = useState('')
  const rename = useMutation({ ...writes.accounts.update(), onSuccess: () => setName('') })

  const trimmed = name.trim()
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (account === undefined || trimmed === '' || rename.isPending) return
    rename.mutate({ id: account.id, displayName: trimmed })
  }

  return (
    <div>
      <h1 className="page-title">Account</h1>
      <QueryState isPending={accountQuery.isPending} error={accountQuery.error}>
        {account ? (
          <>
            <p className="state">
              {account.displayName} · {account.email}
            </p>
            <form className="create-form" onSubmit={onSubmit}>
              <input
                className="input"
                type="text"
                placeholder="Display name…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Display name"
                disabled={rename.isPending}
              />
              <button className="btn" type="submit" disabled={trimmed === '' || rename.isPending}>
                Rename
              </button>
            </form>
          </>
        ) : null}
      </QueryState>
    </div>
  )
}
