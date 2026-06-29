import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

/** The shell: a fixed left sidebar + a scrolling main content area. No player bar (out of scope). */
export function Layout() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
