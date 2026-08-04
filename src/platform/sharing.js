/**
 * Sharing a board, by link.
 *
 * A thin front for four things the database already decides: who may hand a
 * board out, what a link is worth, who is on the board, and who may take
 * someone off it. None of that is enforced here — the policies and the two
 * definer functions are the enforcement, and this would be a second, weaker
 * copy of them.
 *
 * Total, like the repository: a call that cannot be made comes back as null or
 * false. Sharing failing is a dialog that says so, not a board that stops
 * working.
 */

const NOBODY = [];

export function createSharing({ client, auth }) {
  const invites = () => client.from('board_invites');

  return {
    /** The board's live link, or null if it has never been shared. */
    async invite(boardId) {
      const { data, error } = await invites()
        .select('token, role')
        .eq('board_id', boardId)
        .maybeSingle();

      return error || !data ? null : data;
    },

    /**
     * Create the link, or change what it grants. The same call for both,
     * because they are the same row — the token survives a role change, so an
     * outstanding link starts granting the new role rather than dying. That is
     * what "anyone with the link can edit" says, and the alternative is a
     * silently dead link in somebody's chat history.
     */
    async share(boardId, role) {
      const ownerId = auth.current()?.id;
      if (!ownerId) return null;

      const { data, error } = await invites()
        .upsert({ board_id: boardId, role, created_by: ownerId }, { onConflict: 'board_id' })
        .select('token, role')
        .maybeSingle();

      return error || !data ? null : data;
    },

    /** Stop the link working. Everyone who has already joined stays. */
    async revoke(boardId) {
      const { error } = await invites().delete().eq('board_id', boardId);
      return !error;
    },

    /**
     * Everyone with access, owner first. Only the owner gets an answer — the
     * function resolves addresses, so it is deliberately not something a
     * member can ask.
     */
    async people(boardId) {
      const { data, error } = await client.rpc('board_people', { board: boardId });
      if (error || !data) return NOBODY;

      return data.map((row) => ({ id: row.user_id, email: row.email ?? null, role: row.role }));
    },

    /** Take someone off the board. Their access goes; their edits stay. */
    async remove(boardId, userId) {
      const { error } = await client
        .from('board_members')
        .delete()
        .eq('board_id', boardId)
        .eq('user_id', userId);

      return !error;
    },

    /**
     * Join a board with a token. Answers the board id, or null when the token
     * buys nothing — expired, revoked, or never real. The caller cannot tell
     * those apart, which is the point: a token is not something to probe.
     */
    async redeem(token) {
      const { data, error } = await client.rpc('redeem_board_invite', { invite_token: token });
      return error ? null : (data ?? null);
    },
  };
}
