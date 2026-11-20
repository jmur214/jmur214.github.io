// transport.js — the only file that knows HOW messages move. Game code uses the interface:
//
//   const t = createTransport({ kind: 'supabase' | 'local', ... })
//   const unsubscribe = t.subscribe(channelName, onMessage(envelope), onStatus(status))
//   t.send(channelName, envelope)
//   t.close()
//
// onStatus receives 'SUBSCRIBED' each time the channel is (re)joined, plus
// 'CHANNEL_ERROR' / 'TIMED_OUT' / 'CLOSED'. Re-joins after a dropped socket fire
// 'SUBSCRIBED' again, which is the page's cue to send `hello`. A channel that fails is
// retried with backoff until it joins or the page unsubscribes.

export function createTransport(opts = {}) {
  return opts.kind === 'local' ? createLocalTransport(opts.bus) : createSupabaseTransport(opts);
}

// ---------------------------------------------------------------------------
// Supabase Realtime broadcast (production)
// ---------------------------------------------------------------------------

function createSupabaseTransport({ supabaseUrl, supabaseKey }) {
  const lib = globalThis.supabase;
  if (!lib || typeof lib.createClient !== 'function') throw new Error('supabase-js did not load');

  // No auth at all: guests never sign in. detectSessionInUrl=false also stops auth-js
  // from looking at our #fragment.
  const client = lib.createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const channels = new Map(); // name -> { channel, ready, queue, retryTimer, failures }

  function flush(entry) {
    while (entry.ready && entry.queue.length) {
      entry.channel.send({ type: 'broadcast', event: 'm', payload: entry.queue.shift() });
    }
  }

  // Retrying a channel that won't (re)join. supabase-js re-joins by itself after an error or
  // a timeout, but never after the server CLOSES a channel (it just drops it). So after any
  // failure we look again a little later: still not joined -> throw that channel away and
  // join a fresh one. The wait doubles each time (3 s, 6 s, 12 s … up to 30 s) and starts
  // over once it works. If supabase-js got there first, the check finds it joined and stops.
  const RETRY_FIRST_MS = 3000;
  const RETRY_MAX_MS = 30000;

  function join(name, entry) {
    const channel = client.channel(name, { config: { broadcast: { self: false, ack: false } } });
    entry.channel = channel;
    channel.on('broadcast', { event: 'm' }, (msg) => {
      try {
        entry.onMessage(msg && msg.payload);
      } catch (err) {
        console.error('[last-call] handler error', err);
      }
    });
    channel.subscribe((status) => {
      // Ignore a channel we've already replaced or left (its CLOSED comes after).
      if (channels.get(name) !== entry || entry.channel !== channel) return;
      entry.ready = status === 'SUBSCRIBED';
      if (entry.ready) {
        entry.failures = 0;
        flush(entry);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        scheduleRetry(name, entry);
      }
      if (entry.onStatus) entry.onStatus(status);
    });
  }

  function scheduleRetry(name, entry) {
    if (entry.retryTimer) return; // one check at a time
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** entry.failures);
    entry.failures += 1;
    entry.retryTimer = setTimeout(async () => {
      entry.retryTimer = null;
      if (channels.get(name) !== entry || entry.ready) return; // left, or it came back by itself
      const old = entry.channel;
      entry.channel = null; // from here on, the old channel's own status updates are ignored
      try {
        await client.removeChannel(old);
      } catch {
        /* already gone */
      }
      if (channels.get(name) === entry && !entry.ready) join(name, entry);
    }, wait);
  }

  return {
    kind: 'supabase',
    subscribe(name, onMessage, onStatus) {
      const entry = { channel: null, ready: false, queue: [], retryTimer: null, failures: 0, onMessage, onStatus };
      channels.set(name, entry);
      join(name, entry);
      return () => {
        channels.delete(name);
        clearTimeout(entry.retryTimer);
        const channel = entry.channel;
        // Give a just-queued send (e.g. `bye`) a moment to leave before we leave the channel.
        if (channel) setTimeout(() => client.removeChannel(channel), 400);
      };
    },
    send(name, envelope) {
      const entry = channels.get(name);
      if (!entry) return false;
      // Queue until joined: sending earlier makes supabase-js fall back to its REST endpoint.
      if (!entry.ready) {
        entry.queue.push(envelope);
        if (entry.queue.length > 50) entry.queue.shift();
        return true;
      }
      entry.channel.send({ type: 'broadcast', event: 'm', payload: envelope });
      return true;
    },
    close() {
      channels.clear();
      client.removeAllChannels();
    },
  };
}

// ---------------------------------------------------------------------------
// Local transport (tests / dev) — selected with ?transport=local
// ---------------------------------------------------------------------------
// Uses `window.lcLocalBus` if a test injected one ({ post(channel, env), onMessage(handler) }),
// otherwise a BroadcastChannel so two tabs on the same origin can talk.
// Like Supabase with self:false, a page never hears its own messages.

function createLocalTransport(injectedBus) {
  const bus = injectedBus || globalThis.lcLocalBus || broadcastChannelBus();
  const subs = new Map(); // name -> Set<handler>

  bus.onMessage((name, envelope) => {
    const set = subs.get(name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(envelope);
      } catch (err) {
        console.error('[last-call] handler error', err);
      }
    }
  });

  return {
    kind: 'local',
    subscribe(name, onMessage, onStatus) {
      if (!subs.has(name)) subs.set(name, new Set());
      subs.get(name).add(onMessage);
      if (onStatus) setTimeout(() => subs.get(name)?.has(onMessage) && onStatus('SUBSCRIBED'), 0);
      return () => {
        subs.get(name)?.delete(onMessage);
        if (subs.get(name)?.size === 0) subs.delete(name);
      };
    },
    send(name, envelope) {
      bus.post(name, JSON.parse(JSON.stringify(envelope)));
      return true;
    },
    close() {
      subs.clear();
    },
  };
}

function broadcastChannelBus() {
  const bc = new BroadcastChannel('last-call-local');
  return {
    post: (channel, envelope) => bc.postMessage({ channel, envelope }),
    onMessage: (handler) => {
      bc.onmessage = (e) => e.data && handler(e.data.channel, e.data.envelope);
    },
  };
}
