/**
 * Dev only: lets the page run in a plain browser (the Claude desktop app's browser pane) against a windowless debug
 * build of the app (Rust `bridge.rs`). It stands in for Tauri's IPC: commands go to `/__bridge/invoke`, and events
 * and channel messages come back from `/__bridge/events`. Loaded by `main.tsx` only on the dev server with `?bridge`.
 */

type Callback = (message: unknown) => void;

interface BridgeItem {
  seq: number;
  kind: 'event' | 'channel';
  name?: string;
  id?: number;
  payload: unknown;
}

export function installBridge(): void {
  const callbacks = new Map<number, Callback>();
  const listeners: { event: string; handler: number }[] = [];
  const channelIndex = new Map<number, number>();
  let next = 1;

  const internals = {
    transformCallback(callback: Callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === 'plugin:event|listen') {
        listeners.push({ event: String(args.event), handler: Number(args.handler) });
        return listeners.length;
      }
      if (cmd === 'plugin:event|unlisten') return null;
      const res = await fetch('/__bridge/invoke', { method: 'POST', body: JSON.stringify({ cmd, args }) });
      const reply = (await res.json()) as { ok?: unknown; err?: string };
      if ('err' in reply) throw reply.err;
      return reply.ok;
    },
    // Window labels, not words people read.
    // eslint-disable-next-line no-restricted-syntax
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    convertFileSrc: (path: string) => path,
  };
  (window as unknown as { __TAURI_INTERNALS__: typeof internals }).__TAURI_INTERNALS__ = internals;

  let after = 0;
  const poll = async () => {
    for (;;) {
      try {
        const items = (await (await fetch(`/__bridge/events?after=${after}`)).json()) as BridgeItem[];
        for (const item of items) {
          after = Math.max(after, item.seq);
          if (item.kind === 'channel' && item.id != null) {
            const index = channelIndex.get(item.id) ?? 0;
            channelIndex.set(item.id, index + 1);
            callbacks.get(item.id)?.({ index, message: item.payload });
          } else {
            for (const l of listeners.filter((x) => x.event === item.name)) callbacks.get(l.handler)?.({ event: item.name, id: 0, payload: item.payload });
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  void poll();
}
