import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { reads } from '../api/client'

const links = [
  { to: '/', label: 'Browse', end: true },
  { to: '/search', label: 'Search', end: false },
  { to: '/playlists', label: 'Playlists', end: false },
  { to: '/liked', label: 'Liked', end: false },
]

export function Sidebar() {
  // The caller's account is a singleton at /me, read with no id.
  const account = useQuery(reads.accounts.get({ fields: { accounts: ['displayName'] } })).data
  return (
    <nav className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__dot" />
        Music
      </div>
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
        >
          {link.label}
        </NavLink>
      ))}
      <NavLink
        to="/account"
        className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
        aria-label="Account"
      >
        {account?.displayName ?? 'Account'}
      </NavLink>
    </nav>
  )
}
