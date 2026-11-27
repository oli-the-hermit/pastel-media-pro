import { useCallback } from 'react';
import { IconQueue, IconSkip, type MenuItem } from '@pastel-studio/react';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import type { LibTrack } from './library';
import { usePlayback } from './playback';

/**
 * "Play next" and "Add to queue" for a menu: one song's ⋮ menu, or an album's or a playlist's (all its songs). With
 * nothing playing, either one plays the songs. Nothing for songs the player can't read.
 */
export function useQueueActions(): (tracks: LibTrack[]) => MenuItem[] {
  const { playNext, addToQueue } = usePlayback();
  const notify = useNotify();
  return useCallback(
    (tracks) => {
      const songs = tracks.filter((t) => !t.unplayable && !t.missing);
      if (songs.length === 0) return [];
      return [
        {
          key: 'play-next',
          label: strings.playQueue.playNext,
          icon: <IconSkip size={16} />,
          onSelect: () => {
            const n = playNext(songs);
            notify(n === 0 ? strings.playQueue.playing : strings.playQueue.next(n), n === 0 ? 'info' : 'success');
          },
        },
        {
          key: 'add-to-queue',
          label: strings.playQueue.add,
          icon: <IconQueue size={16} />,
          onSelect: () => {
            const n = addToQueue(songs);
            notify(n === 0 ? strings.playQueue.already : strings.playQueue.added(n), n === 0 ? 'info' : 'success');
          },
        },
      ];
    },
    [playNext, addToQueue, notify],
  );
}
