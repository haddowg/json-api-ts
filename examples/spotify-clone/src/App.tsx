import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { AlbumDetailPage } from './pages/AlbumDetailPage'
import { ArtistDetailPage } from './pages/ArtistDetailPage'
import { BrowsePage } from './pages/BrowsePage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SearchPage } from './pages/SearchPage'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<BrowsePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="playlists" element={<PlaylistsPage />} />
        <Route path="playlists/:id" element={<PlaylistDetailPage />} />
        <Route path="albums/:id" element={<AlbumDetailPage />} />
        <Route path="artists/:id" element={<ArtistDetailPage />} />
      </Route>
    </Routes>
  )
}
