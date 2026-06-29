import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: 'Browse', end: true },
  { to: '/search', label: 'Search', end: false },
  { to: '/playlists', label: 'Playlists', end: false },
]

export function Sidebar() {
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
    </nav>
  )
}
