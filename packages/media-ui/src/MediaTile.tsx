import React from 'react';

export interface MediaTileProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title: string;
  /** A second line: the artist, the year, the episode. */
  subtitle?: string;
  /** An image URL for the cover; without one, `icon` sits on a quiet surface. */
  cover?: string;
  icon?: React.ReactNode;
  /** Square for albums, 2:3 for films and series. */
  shape?: 'square' | 'poster';
  /** Marks the tile whose item is playing. */
  current?: boolean;
}

/**
 * A clickable cover with a title under it, for the albums, films and series grids. The design system has
 * no media tile yet; this one is built here first and promoted later (D7).
 */
export function MediaTile({ title, subtitle, cover, icon, shape = 'square', current = false, className, ...rest }: MediaTileProps) {
  return (
    <button type="button" className={['mu-tile', `mu-tile--${shape}`, current ? 'is-current' : '', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      <span className="mu-tile-art">{cover ? <img src={cover} alt="" draggable={false} /> : <span className="mu-tile-icon">{icon}</span>}</span>
      <span className="mu-tile-title">{title}</span>
      {subtitle && <span className="mu-tile-subtitle">{subtitle}</span>}
    </button>
  );
}

/** A responsive grid of tiles. */
export function MediaGrid({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="list" className={['mu-grid', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}
