/**
 * A deterministic CSS-gradient placeholder for cover art (there are no real images in the demo).
 * Two hues are derived from a stable hash of the resource's id/title, so the same resource always
 * renders the same art. An optional glyph (e.g. the title's first letter) sits on top.
 */
import { hashString } from '../lib/format'
import styles from './GradientArt.module.css'

interface GradientArtProps {
  /** A stable seed — an id, slug, or title. */
  seed: string
  /** A short glyph rendered centred (usually the first letter of the title). */
  label?: string
  /** Pixel size of the square (default 56). */
  size?: number
  /** `square` (default) or `circle` (for artists). */
  shape?: 'square' | 'circle'
}

export function GradientArt({ seed, label, size = 56, shape = 'square' }: GradientArtProps) {
  const hash = hashString(seed)
  const h1 = hash % 360
  const h2 = (h1 + 40 + (hash % 80)) % 360
  const background = `linear-gradient(135deg, hsl(${h1} 65% 45%), hsl(${h2} 70% 30%))`
  return (
    <div
      className={shape === 'circle' ? styles.circle : styles.square}
      style={{ width: size, height: size, background, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {label ? label.charAt(0).toUpperCase() : null}
    </div>
  )
}
