import { LOCAL, REMOTE } from '../core/store.js';

/**
 * Live collaboration: the op log, on a wire.
 *
 * The store was built so that every change is a list of plain, serialisable
 * ops. This is the layer that takes that literally — what a client applies
 * locally is exactly what it sends, and what it receives is applied through
 * the same `apply()` the local UI uses. There is no second representation of a
 * change, and so no second implementation to keep honest.
 *
 * Broadcast, not database replication. These messages never touch a table:
 * Postgres holds the settled snapshot that `hydrate()` reads, and the ops
 * between two snapshots are traffic. Replicating per-op through the database
 * would be a write, a WAL record and a fan-out for every frame of a drag.
 *
 * The channel is **private**, so joining it is authorised by row level
 * security on `realtime.messages` — the same `board_role()` that guards the
 * table. A public channel would have made the board's contents readable by
 * anyone who could guess its id, which is the protection the rest of this
 * branch exists to provide.
 *
 * What this does not do is make concurrent editing correct. Ops are applied in
 * arrival order with no transform, so two people dragging the same object
 * settle on whoever's message landed last. That is the honest limit of an op
 * log without a CRDT, and it is fine for the case this is for: several people
 * on one board, mostly working in different corners of it.
 */

export const EVENT = 'ops';

/** A board's topic. The id shape excludes ':', so this parses unambiguously. */
export const topicFor = (boardId) => `board:${boardId}`;

export function createBoardSync({ client, boardId, store, scheduler, onStatus, sendEvery = 50 }) {
  const topic = topicFor(boardId);
  const queue = [];
  let stopped = false;

  /**
   * Ops go out immediately, and then at most every `sendEvery` ms while they
   * keep coming — a drag emits a `set` per pointer move per object, and one
   * message per op would be a burst nobody needs at that resolution. The first
   * op of any gesture is not delayed, so the latency a person notices is the
   * network's rather than this.
   *
   * A timer rather than a frame, deliberately: `requestAnimationFrame` stops
   * in a tab that is not being drawn, which would leave a switched-away tab
   * sitting on ops it had already applied locally.
   */
  const flush = scheduler.throttle(() => {
    const ops = queue.splice(0, queue.length);
    if (!ops.length || stopped) return;
    // A send that fails is a dropped frame of somebody else's view, not a
    // reason to take this session down: the snapshot is still being written.
    Promise.resolve(channel.send({ type: 'broadcast', event: EVENT, payload: { ops } })).catch(
      () => {},
    );
  }, sendEvery);

  const unsubscribeStore = store.onOps((ops, origin) => {
    if (stopped || origin !== LOCAL) return;
    queue.push(...ops);
    flush();
  });

  const channel = client.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  });

  channel.on('broadcast', { event: EVENT }, (message) => {
    const ops = message?.payload?.ops;
    if (stopped || !Array.isArray(ops)) return;

    // record: false — someone else's edit does not belong in this user's undo
    // stack, and REMOTE is what stops it being sent straight back out.
    store.apply(ops, false, REMOTE);
  });

  /**
   * Resolves with the subscription status rather than rejecting. A board that
   * cannot be joined — offline, or a policy that says no — still opens, still
   * edits and still saves; it is a board without other people in it.
   */
  const ready = new Promise((resolve) => {
    // Every status this callback can report is a settled one — SUBSCRIBED, or
    // one of the three ways it did not happen — so the first call is the
    // answer. Waiting for a *particular* status is how you wait forever: a
    // join the policy refuses reports CLOSED, not an error.
    channel.subscribe((status) => {
      onStatus?.(status);
      resolve(status);
    });
  });

  return {
    topic,
    ready,

    async destroy() {
      stopped = true;
      unsubscribeStore();
      await client.removeChannel(channel);
    },
  };
}
