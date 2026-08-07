import { createIdGenerator } from '../core/ids.js';
import { LOCAL, REMOTE, isOp } from '../core/store.js';

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

/**
 * Pointers travel as broadcast, not as presence updates.
 *
 * Presence answers "who is on this board" — it diffs state and fans the whole
 * set out to everyone on every change, which is the right shape for a list of
 * people and the wrong shape for something that moves at pointer rate. A
 * cursor is a fact with a short life; it does not need to be reconciled, only
 * delivered.
 */
export const CURSOR_EVENT = 'cursor';

/** Stands in for a position, so one queue carries "here" and "gone". */
const GONE = Symbol('gone');

/** A board's topic. The id shape excludes ':', so this parses unambiguously. */
export const topicFor = (boardId) => `board:${boardId}`;

/**
 * Who, of everyone on the board, writes the snapshot.
 *
 * Ops keep the live documents identical, but the row in Postgres is written by
 * whole-document save, and every editor autosaving one is every editor able to
 * overwrite the others. So exactly one of them does it, and the rest stop.
 *
 * The rule is earliest joiner, ties broken by id: every client computes it
 * from the same presence state and reaches the same answer without anyone
 * deciding, and someone arriving does not take the job from whoever is already
 * doing it. The clocks are self-reported and need not agree — this is a total
 * order, not a measurement, and choosing the wrong writer is not a failure.
 */
export function electWriter(members) {
  return [...members].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))[0] ?? null;
}

export function createBoardSync({
  client,
  boardId,
  store,
  scheduler,
  onStatus,
  onWriter,
  onCursor,
  onMembers,
  identity = {},
  sendEvery = 50,
  cursorEvery = 60,
  clientId = createIdGenerator()(),
  now = () => Date.now(),
}) {
  const topic = topicFor(boardId);
  const queue = [];
  let stopped = false;

  // True until presence says otherwise — a board nobody else is on is a board
  // this client writes, and so is one where the channel never came up. The
  // version guard in the repository is what covers the case where that is
  // wrong, which is exactly the case presence cannot see.
  let writer = true;

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

  // One sync per client per board. `client.channel()` hands back the channel
  // it already has for a topic rather than a second one, and a channel that
  // has been subscribed refuses new listeners — so building two of these for
  // the same board on one client throws here rather than quietly sharing.
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  });

  channel.on('broadcast', { event: EVENT }, (message) => {
    const ops = message?.payload?.ops;
    if (stopped || !Array.isArray(ops)) return;

    // The whole batch is dropped rather than the bad op filtered out of it.
    // Everyone on this channel is an authorised editor, so this is not a
    // security boundary — it is a version boundary. A sender emitting one op
    // this client cannot read is a sender whose other ops mean something it
    // does not understand either, and half-applying that is worse than
    // ignoring it.
    if (!ops.every(isOp)) return;

    // record: false — someone else's edit does not belong in this user's undo
    // stack, and REMOTE is what stops it being sent straight back out.
    store.apply(ops, false, REMOTE);
  });

  channel.on('broadcast', { event: CURSOR_EVENT }, (message) => {
    const { id, x, y, gone } = message?.payload ?? {};
    if (stopped || typeof id !== 'string') return;

    // Never draw this client's own pointer. `broadcast: { self: false }` is
    // supposed to make this unreachable, and it is the transport's promise
    // rather than ours — one that costs nothing to keep ourselves and that
    // fails invisibly if it is ever broken. Invisibly, because presence
    // excludes self from `onMembers`, so a self-echoed pointer arrives with no
    // label and draws as an anonymous stranger on a board with nobody else on
    // it: the receiver has no way to recognise its own cursor.
    if (id === clientId) return;
    if (gone) return void onCursor?.({ id, gone: true });
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    onCursor?.({ id, x, y });
  });

  /**
   * Everyone currently on the board — what the election needs, and what tells
   * a cursor layer whose pointers to stop drawing. `label` is carried here
   * rather than on every cursor message: it is a property of the person, and
   * repeating it at pointer rate would be paying for it hundreds of times.
   */
  const members = () =>
    Object.values(channel.presenceState())
      .flat()
      .filter((meta) => typeof meta?.id === 'string' && Number.isFinite(meta.at))
      .map(({ id, at, label }) => ({ id, at, label }));

  const settleWriter = () => {
    if (stopped) return;
    const present = members();
    onMembers?.(present.filter((member) => member.id !== clientId));
    const elected = electWriter(present);
    // No presence state yet is not "somebody else writes" — it is nobody
    // having reported in, which leaves this client as the only one it knows.
    const next = elected ? elected.id === clientId : true;
    if (next === writer) return;
    writer = next;
    onWriter?.(writer);
  };

  channel.on('presence', { event: 'sync' }, settleWriter);

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
      // Announcing presence is what makes this client electable — and what
      // tells the incumbent it is no longer alone. Until it lands, everyone
      // already here has an answer that does not include us, which is the
      // right answer for a client that has not arrived.
      if (status === 'SUBSCRIBED') channel.track({ ...identity, id: clientId, at: now() });
      resolve(status);
    });
  });

  /**
   * Where this client's pointer is, in world coordinates — throttled, and
   * dropped rather than queued. An old position is not worth sending: whoever
   * receives it would draw a pointer that is no longer there.
   */
  let pending = null;
  const sendCursor = scheduler.throttle(() => {
    const next = pending;
    pending = null;
    if (!next || stopped) return;

    const payload = next === GONE ? { id: clientId, gone: true } : { id: clientId, ...next };
    Promise.resolve(
      channel.send({ type: 'broadcast', event: CURSOR_EVENT, payload }),
    ).catch(() => {});
  }, cursorEvery);

  return {
    topic,
    ready,
    clientId,

    /** Whether this client is the one that writes the snapshot. */
    isWriter: () => writer,

    /**
     * Everyone else presence currently reports, with their labels — the same
     * list `onMembers` delivers. For tests and for the console, alongside
     * `app.cursors.list()`: between the two, "who is here" and "whose pointer
     * is drawn" can be compared, which is the question a cursor nobody can
     * account for actually poses.
     */
    members: () => members().filter((member) => member.id !== clientId),

    /** A point in world coordinates, or null for "my pointer has left". */
    moveCursor(point) {
      if (stopped) return;
      pending = point ?? GONE;
      sendCursor();
    },

    async destroy() {
      stopped = true;
      unsubscribeStore();
      await client.removeChannel(channel);
    },
  };
}
