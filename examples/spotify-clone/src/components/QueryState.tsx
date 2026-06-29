import type { ReactNode } from 'react'

interface QueryStateProps {
  isPending: boolean
  error: unknown
  /** True when a successful query returned nothing to show. */
  isEmpty?: boolean
  emptyLabel?: string
  children: ReactNode
}

/** Uniform loading / error / empty wrapper around a query-backed view. */
export function QueryState({ isPending, error, isEmpty, emptyLabel, children }: QueryStateProps) {
  if (isPending) return <p className="state">Loading…</p>
  if (error) return <p className="state state--error">{errorMessage(error)}</p>
  if (isEmpty) return <p className="state">{emptyLabel ?? 'Nothing here yet.'}</p>
  return <>{children}</>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}
